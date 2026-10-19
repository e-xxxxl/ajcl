import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/**
 * Payment ledger — one row per transaction attempt. The Booking carries a
 * denormalised summary in `booking.payment`; this collection is the audit
 * trail (init → verify → webhook) and the source of truth for revenue.
 */
const paymentSchema = new Schema(
  {
    /** Set for local bookings and for a shipment's pickup fee. */
    booking: { type: Schema.Types.ObjectId, ref: "Booking", index: true },
    /** Set for a shipment's final shipping total (and its pickup fee, via the pickup booking). */
    shipment: { type: Schema.Types.ObjectId, ref: "Shipment", index: true, sparse: true },
    /** booking: a local delivery. pickup_fee: the rider's trip to our office. shipping_total: the carrier price. */
    purpose: { type: String, enum: ["booking", "pickup_fee", "shipping_total"], default: "booking", index: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    provider: { type: String, default: "paystack" },
    reference: { type: String, required: true, unique: true, index: true },
    accessCode: { type: String },
    amount: { type: Number, required: true, min: 0 }, // major units (Naira)
    amountMinor: { type: Number, required: true, min: 0 }, // kobo
    currency: { type: String, default: "NGN" },
    status: {
      type: String,
      enum: ["initialized", "pending", "success", "failed", "abandoned", "refunded"],
      default: "initialized",
      index: true,
    },
    channel: { type: String },
    /** How the status was last confirmed. */
    verifiedVia: { type: String, enum: ["none", "callback", "webhook"], default: "none" },
    paidAt: { type: Date },
    gatewayResponse: { type: String },
    /** Full provider payloads for dispute resolution. */
    raw: { type: Schema.Types.Mixed, select: false },
  },
  { timestamps: true },
);

paymentSchema.index({ createdAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 });

paymentSchema.set("toJSON", {
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.__v;
    delete ret.raw;
    return ret;
  },
});

export type PaymentDoc = InferSchemaType<typeof paymentSchema> & { _id: string };

export const Payment: Model<PaymentDoc> =
  (models.Payment as Model<PaymentDoc>) ?? model<PaymentDoc>("Payment", paymentSchema);
