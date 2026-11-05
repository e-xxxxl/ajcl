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
import { priceForBundle, assertAmountMatches, type ReconcileOutcome } from "./payment";

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
  expectedAmount?: number,
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
  assertAmountMatches(expectedAmount, charged);
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
  if (verification.status === "success" && verification.amountMinor > expectedMinor) {
    // More was taken than the price. Our code never adds anything, so this is Paystack passing its own charge on to the customer
    // (Paystack dashboard > Settings > Preferences: customers pay the transaction fee). Turn that off to charge exactly the price.
    console.warn(`[payments] ${ledger.reference}: Paystack took ${verification.amountMinor / 100} but the price was ${expectedMinor / 100}. Is "customer pays the fee" switched on in the Paystack dashboard?`);
  }

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
    moved.shipmentType === "interstate"
      ? `We received your payment for shipment ${moved.reference}. We are arranging a driver and will send you the driver's number once one is assigned.`
      : `We received your payment for shipment ${moved.reference}. We are booking it with the carrier now.`,
    moved.reference,
  );

  const option = moved.quote.options.find((o) => o.rateId === moved.quote.selectedRateId);
  let finalShipment: ShipmentHydrated = moved;
  if (option?.manual) {
    // A hand-quoted shipment is booked by staff, not through Terminal.
    await notifyOffice(
      "admin_shipment_new",
      moved.shipmentType === "interstate" ? "Paid: assign a driver" : "Manual shipment paid",
      moved.shipmentType === "interstate"
        ? `${moved.reference} is paid. Assign a driver and add the driver's number.`
        : `${moved.reference} is paid. Book it with the carrier and record the tracking number.`,
      moved.reference,
    );
  } else {
    finalShipment = await bookWithTerminal(String(moved._id));
  }
  return { booking: null, shipment: finalShipment, paid: true, status: "paid" };
}

/**
 * Super Admin: a payment really happened but the system never saw it (a bank transfer, or the card was charged and the
 * gateway never reported back). It records the payment against the shipment and pushes it through the same path a
 * real payment takes, so the shipment moves on exactly as it would have: a paid interstate shipment waits for a driver,
 * a paid international shipment is booked with the carrier, a paid pickup fee sends the rider. The payment is kept in
 * the ledger (provider "manual", with who recorded it and why), so it counts in revenue and can be audited.
 */
export async function markShipmentPaid(
  shipment: ShipmentHydrated,
  actor: { id?: string; name: string; role: "customer" | "admin" | "office_admin" | "system" | "carrier" },
  input: { target: "shipping" | "pickup_fee"; rateId?: string; note: string },
): Promise<ShipmentHydrated> {
  await connectToDatabase();
  const stamp = Date.now().toString(36).toUpperCase();
  const paidAt = new Date().toISOString();
  const gatewayResponse = `Marked as paid by ${actor.name}: ${input.note}`.slice(0, 300);
  const raw = { manual: true, by: actor.name, note: input.note };

  if (input.target === "pickup_fee") {
    if (shipment.status !== "pickup_fee_pending" || !shipment.handover.pickupBooking) {
      throw new ApiError("There is no unpaid pickup fee on this shipment.", 409);
    }
    const booking = await Booking.findById(shipment.handover.pickupBooking);
    if (!booking || booking.payment?.status === "paid") throw new ApiError("The pickup fee is already paid.", 409);
    const amount = booking.pricing.total;
    const reference = `MANUAL-${shipment.reference}-P-${stamp}`;
    await Payment.create({
      booking: booking._id,
      shipment: shipment._id,
      purpose: "pickup_fee",
      user: shipment.user,
      provider: "manual",
      reference,
      amount,
      amountMinor: toMinorUnits(amount),
      currency: "NGN",
      status: "initialized",
    });
    const { reconcilePayment } = await import("./payment");
    await reconcilePayment({ status: "success", reference, amountMinor: toMinorUnits(amount), currency: "NGN", channel: "manual", paidAt, gatewayResponse, raw }, "callback");
  } else {
    // The same three situations as a real payment: a quote to pay, paying in advance (international), or the extra fee
    // after weighing a shipment that was paid in advance.
    const extraMode = shipment.prepaid && shipment.status === "quote_sent";
    const advanceMode =
      !shipment.shippingPaidAt && shipment.quote.prepayOffered && shipment.shipmentType === "international" && PREPAY_STATUSES.includes(shipment.status as never);
    if (shipment.status !== "quote_sent" && !advanceMode) {
      throw new ApiError(shipment.shippingPaidAt ? "This shipment has already been paid." : "There is no price to pay for this shipment yet.", 409);
    }
    const options = shipment.quote.options;
    const wanted = extraMode ? shipment.quote.selectedRateId ?? input.rateId : input.rateId;
    const option = wanted ? options.find((o) => o.rateId === wanted) : options.length === 1 ? options[0] : undefined;
    if (!option) throw new ApiError(options.length === 0 ? "There is no price to pay for this shipment yet." : "Choose which option the customer paid for.", 422);
    const payable = extraMode ? Math.round((option.total - (shipment.shippingAmount ?? 0)) * 100) / 100 : option.total;
    if (!option.total || option.total <= 0 || payable <= 0) throw new ApiError("Nothing is due on this shipment.", 409);

    shipment.quote.selectedRateId = option.rateId;
    shipment.quote.selectedAt = new Date();
    if (advanceMode) shipment.quote.prepaidCarrier = option.carrierName;
    await shipment.save();

    const reference = `MANUAL-${shipment.reference}-S-${stamp}`;
    const ledger = await Payment.create({
      shipment: shipment._id,
      purpose: "shipping_total",
      user: shipment.user,
      provider: "manual",
      reference,
      amount: payable,
      amountMinor: toMinorUnits(payable),
      currency: "NGN",
      status: "initialized",
    });
    await reconcileShippingPayment(ledger as never, { status: "success", reference, amountMinor: toMinorUnits(payable), currency: "NGN", channel: "manual", paidAt, gatewayResponse, raw }, "callback");
  }

  const fresh = (await Shipment.findById(shipment._id)) ?? shipment;
  fresh.statusHistory.push({ status: fresh.status, note: gatewayResponse, byRole: actor.role, byName: actor.name, at: new Date() });
  await fresh.save();
  return fresh;
}
