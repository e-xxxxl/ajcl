import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/** One proof photo. Bytes live in their own collection so listing proofs stays light. */
const proofPhotoSchema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    contentType: { type: String, enum: ["image/jpeg", "image/png", "image/webp"], required: true },
    size: { type: Number, required: true },
    /** "cloudinary": bytes live in the AJCL folder on Cloudinary. "mongo": stored here (fallback / older photos). */
    storage: { type: String, enum: ["mongo", "cloudinary"], default: "mongo" },
    publicId: { type: String },
    version: { type: Number },
    format: { type: String },
    data: {
      type: Buffer,
      select: false,
      required: function (this: { storage?: string }) {
        return this.storage !== "cloudinary";
      },
    },
  },
  { timestamps: true },
);

export type ProofPhotoDoc = InferSchemaType<typeof proofPhotoSchema> & { _id: string };

export const ProofPhoto: Model<ProofPhotoDoc> =
  (models.ProofPhoto as Model<ProofPhotoDoc>) ?? model<ProofPhotoDoc>("ProofPhoto", proofPhotoSchema);
