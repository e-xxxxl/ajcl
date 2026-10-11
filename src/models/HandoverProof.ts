import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/**
 * Evidence captured when a rider confirms a pickup or a delivery: where they
 * were (GPS) and photo(s) of the handover. One per stage per booking.
 */
const locationFixSchema = new Schema(
  {
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    /** GPS accuracy radius in metres, as reported by the device. */
    accuracyM: { type: Number, min: 0 },
    /** When the device took the fix. */
    capturedAt: { type: Date, required: true },
    /** Straight-line metres from the booked address, when that address has coordinates. */
    distanceFromTargetM: { type: Number, min: 0 },
    /** True when the rider was clearly outside the radius around the booked address. */
    flagged: { type: Boolean, default: false },
  },
  { _id: false },
);

const handoverProofSchema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    bookingReference: { type: String, required: true, index: true },
    stage: { type: String, enum: ["pickup", "delivery"], required: true },
    rider: { type: Schema.Types.ObjectId, ref: "User", required: true },
    riderName: { type: String, trim: true },
    location: { type: locationFixSchema, required: true },
    photos: [{ type: Schema.Types.ObjectId, ref: "ProofPhoto" }],
  },
  { timestamps: true },
);

handoverProofSchema.index({ booking: 1, stage: 1 });
handoverProofSchema.index({ createdAt: -1 });

export type HandoverProofDoc = InferSchemaType<typeof handoverProofSchema> & { _id: string };

export const HandoverProof: Model<HandoverProofDoc> =
  (models.HandoverProof as Model<HandoverProofDoc>) ??
  model<HandoverProofDoc>("HandoverProof", handoverProofSchema);
