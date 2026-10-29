import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/**
 * The moment revenue was last cleared. Revenue totals count only payments made after it. The payment records
 * themselves are kept (they are the audit trail and the proof for any dispute); only the totals start again from zero.
 */
const revenueResetSchema = new Schema(
  {
    key: { type: String, default: "revenue", unique: true },
    at: { type: Date, required: true },
    /** What the totals stood at when they were cleared, in naira. */
    clearedTotal: { type: Number, default: 0 },
    byName: { type: String, trim: true },
  },
  { timestamps: true },
);

export type RevenueResetDoc = InferSchemaType<typeof revenueResetSchema> & { _id: string };

export const RevenueReset: Model<RevenueResetDoc> =
  (models.RevenueReset as Model<RevenueResetDoc>) ?? model<RevenueResetDoc>("RevenueReset", revenueResetSchema);
