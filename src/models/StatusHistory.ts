import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/**
 * Immutable audit log of every booking status change. The Booking also keeps
 * an embedded `statusHistory` for quick reads; this collection is the
 * queryable, tamper-evident record used by the admin audit view.
 */
const statusHistorySchema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    bookingReference: { type: String, required: true, index: true },
    fromStatus: { type: String },
    toStatus: { type: String, required: true },
    note: { type: String, trim: true, maxlength: 500 },
    actorRole: { type: String, enum: ["system", "customer", "admin"], required: true },
    actor: { type: Schema.Types.ObjectId, ref: "User" },
    actorName: { type: String },
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false },
);

statusHistorySchema.index({ booking: 1, at: -1 });

export type StatusHistoryDoc = InferSchemaType<typeof statusHistorySchema> & { _id: string };

export const StatusHistory: Model<StatusHistoryDoc> =
  (models.StatusHistory as Model<StatusHistoryDoc>) ??
  model<StatusHistoryDoc>("StatusHistory", statusHistorySchema);
