import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/** One proof photo. Bytes live in their own collection so listing proofs stays light. */
const proofPhotoSchema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    contentType: { type: String, enum: ["image/jpeg", "image/png", "image/webp"], required: true },
    size: { type: Number, required: true },
    data: { type: Buffer, required: true, select: false },
  },
  { timestamps: true },
);

export type ProofPhotoDoc = InferSchemaType<typeof proofPhotoSchema> & { _id: string };

export const ProofPhoto: Model<ProofPhotoDoc> =
  (models.ProofPhoto as Model<ProofPhotoDoc>) ?? model<ProofPhotoDoc>("ProofPhoto", proofPhotoSchema);
