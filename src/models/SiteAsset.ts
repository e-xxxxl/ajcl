import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/**
 * A file the Super Admin uploaded for the public site: slide images, the Sea Cargo flier,
 * and price list PDFs. Bytes live on Cloudinary (AJCL folder) when configured, otherwise in
 * MongoDB. Files are served through the API, never linked directly.
 */
const siteAssetSchema = new Schema(
  {
    purpose: { type: String, enum: ["slide", "flier", "price_list"], required: true, index: true },
    filename: { type: String, trim: true, maxlength: 200 },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    storage: { type: String, enum: ["mongo", "cloudinary"], default: "mongo" },
    publicId: { type: String },
    version: { type: Number },
    format: { type: String },
    resourceType: { type: String, enum: ["image", "raw"], default: "image" },
    data: {
      type: Buffer,
      select: false,
      required: function (this: { storage?: string }) {
        return this.storage !== "cloudinary";
      },
    },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

export type SiteAssetDoc = InferSchemaType<typeof siteAssetSchema> & { _id: string };

export const SiteAsset: Model<SiteAssetDoc> =
  (models.SiteAsset as Model<SiteAssetDoc>) ?? model<SiteAssetDoc>("SiteAsset", siteAssetSchema);
