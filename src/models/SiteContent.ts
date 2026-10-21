import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/**
 * Editable public-site content (one document, key "default"). Only what the Super Admin has
 * changed is stored here; the defaults live in lib/services/site-content.ts, so a missing
 * field just falls back to the default and the homepage never breaks.
 */
const slideSchema = new Schema(
  {
    key: { type: String, required: true, enum: ["local", "international", "air", "sea", "express"] },
    title: { type: String, trim: true, maxlength: 120 },
    subtitle: { type: String, trim: true, maxlength: 240 },
    ctaLabel: { type: String, trim: true, maxlength: 40 },
    imageAsset: { type: Schema.Types.ObjectId, ref: "SiteAsset" },
    active: { type: Boolean, default: true },
  },
  { _id: false },
);

const sectionSchema = new Schema(
  { heading: { type: String, trim: true, maxlength: 120 }, body: { type: String, trim: true, maxlength: 2000 } },
  { _id: false },
);

const siteContentSchema = new Schema(
  {
    key: { type: String, default: "default", unique: true },
    slides: { type: [slideSchema], default: [] },
    airCargo: {
      title: { type: String, trim: true, maxlength: 120 },
      intro: { type: String, trim: true, maxlength: 1200 },
      sections: { type: [sectionSchema], default: undefined },
      /** The air cargo rate card or document (image or PDF). */
      rateCard: { type: Schema.Types.ObjectId, ref: "SiteAsset" },
      notes: { type: [String], default: undefined },
    },
    seaCargo: {
      title: { type: String, trim: true, maxlength: 120 },
      intro: { type: String, trim: true, maxlength: 1200 },
      sections: { type: [sectionSchema], default: undefined },
      notes: { type: [String], default: undefined },
    },
    express: {
      title: { type: String, trim: true, maxlength: 120 },
      intro: { type: String, trim: true, maxlength: 1200 },
      paragraphs: { type: [String], default: undefined },
    },
    seaFlier: { type: Schema.Types.ObjectId, ref: "SiteAsset" },
  },
  { timestamps: true },
);

export type SiteContentDoc = InferSchemaType<typeof siteContentSchema> & { _id: string };

export const SiteContent: Model<SiteContentDoc> =
  (models.SiteContent as Model<SiteContentDoc>) ?? model<SiteContentDoc>("SiteContent", siteContentSchema);
