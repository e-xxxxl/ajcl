import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/**
 * A pop-up flyer shown over the landing page (usually a portrait poster). It is live between
 * `startsAt` and `endsAt`; `durationDays` is what the Super Admin chose, kept so the form can show it again.
 */
const flyerSchema = new Schema(
  {
    title: { type: String, trim: true, maxlength: 120, default: "" },
    asset: { type: Schema.Types.ObjectId, ref: "SiteAsset", required: true },
    /** Where the flyer goes when it is clicked: a path on this site ("/send") or an https address. Optional. */
    linkUrl: { type: String, trim: true, maxlength: 300 },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true, index: true },
    durationDays: { type: Number, required: true, min: 1, max: 365 },
    active: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

export type FlyerDoc = InferSchemaType<typeof flyerSchema> & { _id: string };

export const Flyer: Model<FlyerDoc> = (models.Flyer as Model<FlyerDoc>) ?? model<FlyerDoc>("Flyer", flyerSchema);
