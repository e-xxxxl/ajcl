import { connectToDatabase } from "../db";
import { Payment, type PaymentDoc } from "../../models/Payment";
import { Shipment, type ShipmentHydrated } from "../../models/Shipment";
import { Booking } from "../../models/Booking";
import { User } from "../../models/User";
import { ApiError } from "../api";
import { env } from "../env";
import { siteUrl } from "../origins";
import { toMinorUnits } from "../pricing/engine";
import { initializeTransaction, type PaystackVerifyResult } from "../paystack";
import { findOwnShipment, setStatus, SYSTEM, PREPAY_STATUSES } from "./shipments";
import { bookWithTerminal } from "./shipment-terminal";
import { notifyCustomer, notifyOffice } from "./shipment-notify";
import { priceForBundle, type ReconcileOutcome } from "./payment";

/**
 * The carrier price of a shipment is its own Paystack transaction, separate from the pickup
 * fee. The customer picks one of the options the Office Admin sent, we charge that option's
 * total, and only a verified successful payment for the full amount moves the shipment on.
 */

export async function initializeShippingPayment(
  userId: string,
  reference: string,
  rateId: string,
  includePickupFee = false,
): Promise<{ authorizationUrl: string; reference: string; amount: number; shippingAmount: number; pickupFee: number }> {
  await connectToDatabase();
  const shipment = await findOwnShipment(userId, reference);

  // Three ways to pay: a normal quote (after weighing), in advance (international, before weighing), or only the
  // difference after weighing a shipment that was paid in advance.
  const extraMode = shipment.prepaid && shipment.status === "quote_sent";
  const advanceMode =
    !shipment.shippingPaidAt && shipment.quote.prepayOffered && shipment.shipmentType === "international" && PREPAY_STATUSES.includes(shipment.status as never);
  if (shipment.status !== "quote_sent" && !advanceMode) {
    throw new ApiError(
      shipment.status === "paid" || shipment.status === "booked" || shipment.shippingPaidAt
        ? "This shipment has already been paid."
        : "There is no quote to pay for this shipment yet.",
      409,
    );
  }
  const option = shipment.quote.options.find((o) => o.rateId === (extraMode ? shipment.quote.selectedRateId ?? rateId : rateId));
  if (!option) throw new ApiError("That delivery option is no longer available.", 404);
  if (!option.total || option.total <= 0) throw new ApiError("This option has no payable amount.", 422);
  const payable = extraMode ? Math.round((option.total - (shipment.shippingAmount ?? 0)) * 100) / 100 : option.total;
  if (payable <= 0) throw new ApiError("Nothing more is due on this shipment.", 409);
  if (!env.paystackSecretKey) throw new ApiError("Payments are not configured. Please contact support.", 503);

  const user = await User.findById(userId).lean();
  if (!user) throw new ApiError("Account not found.", 404);

  shipment.quote.selectedRateId = option.rateId;
  shipment.quote.selectedAt = new Date();
  if (advanceMode) shipment.quote.prepaidCarrier = option.carrierName;
  await shipment.save();

  // One charge can pay the pickup fee too (international: pickup fee + only the carrier chosen).
  let pickup: { amount: number } | null = null;
  let pickupBooking: InstanceType<typeof Booking> | null = null;
  if (includePickupFee) {
    if (!advanceMode || shipment.status !== "pickup_fee_pending" || !shipment.handover.pickupBooking) {
      throw new ApiError("There is no unpaid pickup fee to include.", 409);
    }
    pickupBooking = await Booking.findById(shipment.handover.pickupBooking);
    if (!pickupBooking) throw new ApiError("The pickup for this shipment could not be found.", 404);
    pickup = { amount: await priceForBundle(pickupBooking) };
  }

  const amount = payable;
  const amountMinor = toMinorUnits(amount);
  const charged = amount + (pickup?.amount ?? 0);
  const chargedMinor = toMinorUnits(charged);
  const txReference = `${shipment.reference}-S-${Date.now().toString(36).toUpperCase()}`;

  const init = await initializeTransaction({
    email: user.email,
    amountMinor: chargedMinor,
    reference: txReference,
    currency: "NGN",
    callbackUrl: `${siteUrl()}/book/payment/callback?ref=${shipment.reference}&kind=shipment`,
    metadata: {
      shipmentReference: shipment.reference,
      shipmentId: String(shipment._id),
      userId,
      custom_fields: [{ display_name: "Shipment", variable_name: "shipment_reference", value: shipment.reference }],
    },
  });

  if (pickup && pickupBooking) {
    // The pickup half keeps its own ledger row and booking summary, settled together with this charge.
    const pickupReference = `${init.reference}-P`;
    pickupBooking.payment.provider = "paystack";
    pickupBooking.payment.status = "pending";
    pickupBooking.payment.reference = pickupReference;
    pickupBooking.payment.amount = pickup.amount;
    await pickupBooking.save();
    await Payment.create({
      booking: pickupBooking._id,
      shipment: shipment._id,
      purpose: "pickup_fee",
      user: userId,
      reference: pickupReference,
      amount: pickup.amount,
      amountMinor: toMinorUnits(pickup.amount),
      currency: "NGN",
      status: "initialized",
    });
  }

  await Payment.create({
    shipment: shipment._id,
    purpose: "shipping_total",
    user: userId,
    reference: init.reference,
    accessCode: init.accessCode,
    amount,
    amountMinor,
    ...(pickup && pickupBooking ? { chargedMinor, bundledBooking: pickupBooking._id } : {}),
    currency: "NGN",
    status: "initialized",
  });

  return { authorizationUrl: init.authorizationUrl, reference: init.reference, amount: charged, shippingAmount: amount, pickupFee: pickup?.amount ?? 0 };
}

/** When this charge also paid the pickup fee, settle that half too. Safe to run again. */
async function settleBundledPickup(ledger: InstanceType<typeof Payment> & PaymentDoc, verification: PaystackVerifyResult, via: "callback" | "webhook") {
  if (!ledger.bundledBooking) return;
  try {
    const { reconcilePayment } = await import("./payment");
    await reconcilePayment({ ...verification, reference: `${ledger.reference}-P` }, via);
  } catch (err) {
    console.error(`[shipments] the pickup half of ${ledger.reference} could not be settled`, err instanceof Error ? err.message : err);
  }
}

/** Apply a Paystack verification to a shipping payment. Idempotent (callback and webhook both call it). */
export async function reconcileShippingPayment(
  ledger: InstanceType<typeof Payment> & PaymentDoc,
  verification: PaystackVerifyResult,
  via: "callback" | "webhook",
): Promise<ReconcileOutcome> {
  await connectToDatabase();
  const shipment = await Shipment.findById(ledger.shipment);
  if (!shipment) throw new ApiError("Unknown payment reference.", 404);

  if (ledger.status === "success") {
    await settleBundledPickup(ledger, verification, via);
    return { booking: null, shipment: (await Shipment.findById(shipment._id)) ?? shipment, paid: true, status: "paid" };
  }

  // The amount that must have been paid is what was charged when the payment was started.
  const expectedMinor = ledger.chargedMinor ?? ledger.amountMinor;
  const amountOk = verification.amountMinor >= expectedMinor;
  const success = verification.status === "success" && amountOk;

  ledger.status = success ? "success" : verification.status === "pending" ? "pending" : "failed";
  ledger.channel = verification.channel;
  ledger.verifiedVia = via;
  ledger.gatewayResponse = verification.gatewayResponse;
  ledger.paidAt = verification.paidAt ? new Date(verification.paidAt) : undefined;
  ledger.set("raw", verification.raw);
  if (!amountOk && verification.status === "success") {
    ledger.gatewayResponse = `Amount mismatch: paid ${verification.amountMinor}, expected ${expectedMinor}`;
  }
  await ledger.save();

  if (!success) {
    return { booking: null, shipment, paid: false, status: ledger.status };
  }

  // Paid in advance (international, before weighing): record it and wait for the parcel. Nothing is booked yet.
  if (!shipment.shippingPaidAt && shipment.quote.prepayOffered && PREPAY_STATUSES.includes(shipment.status as never)) {
    const early = await Shipment.findOneAndUpdate(
      { _id: shipment._id, shippingPaidAt: { $exists: false }, status: { $in: PREPAY_STATUSES } },
      {
        $set: { prepaid: true, shippingPaidAt: ledger.paidAt ?? new Date(), shippingAmount: ledger.amount },
        $push: {
          statusHistory: { status: shipment.status, note: "Shipping paid in advance on the customer's weight", byRole: "system", byName: SYSTEM.name, at: new Date() },
        },
      },
      { returnDocument: "after" },
    );
    if (early) {
      await notifyCustomer(
        String(early.user),
        "shipment_paid",
        "Shipping payment received",
        `We received your shipping payment for ${early.reference}. When we weigh your package at our office, if its weight is more than the ${early.parcel.estimatedWeightKg} kg you entered you will be asked to pay the additional fee before it ships.`,
        early.reference,
      );
      await notifyOffice("admin_shipment_new", "Shipment paid in advance", `${early.reference} is paid in advance. Weigh it when it arrives: any difference is priced automatically.`, early.reference);
      await settleBundledPickup(ledger, verification, via);
      return { booking: null, shipment: (await Shipment.findById(early._id)) ?? early, paid: true, status: early.status };
    }
    await settleBundledPickup(ledger, verification, via);
    const current = (await Shipment.findById(shipment._id)) ?? shipment;
    return { booking: null, shipment: current, paid: true, status: current.status };
  }

  // Claim the paid transition atomically so a webhook racing the callback only books once.
  const additional = Boolean(shipment.prepaid);
  const moved = await Shipment.findOneAndUpdate(
    { _id: shipment._id, status: "quote_sent" },
    {
      $set: additional ? { status: "paid" } : { status: "paid", shippingPaidAt: ledger.paidAt ?? new Date(), shippingAmount: ledger.amount },
      ...(additional ? { $inc: { shippingAmount: ledger.amount } } : {}),
      $push: {
        statusHistory: { status: "paid", note: "Shipping payment received", byRole: "system", byName: SYSTEM.name, at: new Date() },
      },
    },
    { returnDocument: "after" },
  );
  if (!moved) {
    return { booking: null, shipment: (await Shipment.findById(shipment._id)) ?? shipment, paid: true, status: "paid" };
  }

  await notifyCustomer(
    String(moved.user),
    "shipment_paid",
    "Shipping payment received",
    `We received your payment for shipment ${moved.reference}. We are booking it with the carrier now.`,
    moved.reference,
  );

  const option = moved.quote.options.find((o) => o.rateId === moved.quote.selectedRateId);
  let finalShipment: ShipmentHydrated = moved;
  if (option?.manual) {
    // A hand-quoted shipment is booked by staff, not through Terminal.
    await notifyOffice("admin_shipment_new", "Manual shipment paid", `${moved.reference} is paid. Book it with the carrier and record the tracking number.`, moved.reference);
  } else {
    finalShipment = await bookWithTerminal(String(moved._id));
  }
  return { booking: null, shipment: finalShipment, paid: true, status: "paid" };
}
