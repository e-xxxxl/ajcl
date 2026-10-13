import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/**
 * A payment an admin recorded against a partner's outstanding balance.
 * Partners don't pay in the app: they settle (in full or in part) by transfer, cash or
 * cheque, and the admin logs it here. Outstanding = billed orders minus these payments.
 */
const partnerPaymentSchema = new Schema(
  {
    partner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amount: { type: Number, required: true, min: 0.01 },
    method: { type: String, enum: ["transfer", "cash", "cheque", "other"], default: "transfer" },
    /** Bank transfer reference, cheque number, etc. */
    reference: { type: String, trim: true, maxlength: 120 },
    note: { type: String, trim: true, maxlength: 500 },
    /** When the money was actually received (can be earlier than when it was recorded). */
    receivedAt: { type: Date, required: true, default: Date.now },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User" },
    recordedByName: { type: String, trim: true },
  },
  { timestamps: true },
);

partnerPaymentSchema.index({ partner: 1, receivedAt: -1 });

export type PartnerPaymentDoc = InferSchemaType<typeof partnerPaymentSchema> & { _id: string };

export const PartnerPayment: Model<PartnerPaymentDoc> =
  (models.PartnerPayment as Model<PartnerPaymentDoc>) ??
  model<PartnerPaymentDoc>("PartnerPayment", partnerPaymentSchema);
