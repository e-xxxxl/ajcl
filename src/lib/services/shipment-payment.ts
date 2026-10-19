import { connectToDatabase } from "../db";
import { Payment, type PaymentDoc } from "../../models/Payment";
import { Shipment, type ShipmentHydrated } from "../../models/Shipment";
import { User } from "../../models/User";
import { ApiError } from "../api";
import { env } from "../env";
import { siteUrl } from "../origins";
import { toMinorUnits } from "../pricing/engine";
import { initializeTransaction, type PaystackVerifyResult } from "../paystack";
import { findOwnShipment, setStatus, SYSTEM } from "./shipments";
import { bookWithTerminal } from "./shipment-terminal";
import { notifyCustomer, notifyOffice } from "./shipment-notify";
import type { ReconcileOutcome } from "./payment";

/**
 * The carrier price of a shipment is its own Paystack transaction, separate from the pickup
 * fee. The customer picks one of the options the Office Admin sent, we charge that option's
 * total, and only a verified successful payment for the full amount moves the shipment on.
 */

export async function initializeShippingPayment(
  userId: string,
  reference: string,
  rateId: string,
): Promise<{ authorizationUrl: string; reference: string; amount: number }> {
  await connectToDatabase();
  const shipment = await findOwnShipment(userId, reference);

  if (shipment.status !== "quote_sent") {
    throw new ApiError(
      shipment.status === "paid" || shipment.status === "booked"
        ? "This shipment has already been paid."
        : "There is no quote to pay for this shipment yet.",
      409,
    );
  }
  const option = shipment.quote.options.find((o) => o.rateId === rateId);
  if (!option) throw new ApiError("That delivery option is no longer available.", 404);
  if (!option.total || option.total <= 0) throw new ApiError("This option has no payable amount.", 422);
  if (!env.paystackSecretKey) throw new ApiError("Payments are not configured. Please contact support.", 503);

  const user = await User.findById(userId).lean();
  if (!user) throw new ApiError("Account not found.", 404);

  shipment.quote.selectedRateId = option.rateId;
  shipment.quote.selectedAt = new Date();
  await shipment.save();

  const amount = option.total;
  const amountMinor = toMinorUnits(amount);
  const txReference = `${shipment.reference}-S-${Date.now().toString(36).toUpperCase()}`;

  const init = await initializeTransaction({
    email: user.email,
    amountMinor,
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

  await Payment.create({
    shipment: shipment._id,
    purpose: "shipping_total",
    user: userId,
    reference: init.reference,
    accessCode: init.accessCode,
    amount,
    amountMinor,
    currency: "NGN",
    status: "initialized",
  });

  return { authorizationUrl: init.authorizationUrl, reference: init.reference, amount };
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
    return { booking: null, shipment, paid: true, status: "paid" };
  }

  // The amount that must have been paid is what was charged when the payment was started.
  const expectedMinor = ledger.amountMinor;
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

  // Claim the paid transition atomically so a webhook racing the callback only books once.
  const moved = await Shipment.findOneAndUpdate(
    { _id: shipment._id, status: "quote_sent" },
    {
      $set: { status: "paid", shippingPaidAt: ledger.paidAt ?? new Date(), shippingAmount: ledger.amount },
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
