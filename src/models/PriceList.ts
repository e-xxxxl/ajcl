import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/**
 * AJCL Express monthly price list (a PDF). Every upload is kept for history; only the most
 * recent one is public.
 */
const priceListSchema = new Schema(
  {
    /** What the admin typed, e.g. "November 2026". */
    monthLabel: { type: String, required: true, trim: true, maxlength: 60 },
    /** "YYYY-MM", used to order lists and say which month this applies to. */
    effectiveMonth: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/, index: true },
    asset: { type: Schema.Types.ObjectId, ref: "SiteAsset", required: true },
    originalFilename: { type: String, trim: true, maxlength: 200 },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User" },
    uploadedByName: { type: String, trim: true },
  },
  { timestamps: true },
);

priceListSchema.index({ createdAt: -1 });

export type PriceListDoc = InferSchemaType<typeof priceListSchema> & { _id: string };

export const PriceList: Model<PriceListDoc> =
  (models.PriceList as Model<PriceListDoc>) ?? model<PriceListDoc>("PriceList", priceListSchema);
