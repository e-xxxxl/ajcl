import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/**
 * Settings for the rider delivery flow (/book), kept apart from the shipping settings. One document.
 * The long-distance fee is set by the Super Admin only. Customers never see it: it is part of their total.
 */
const rideSettingsSchema = new Schema(
  {
    key: { type: String, default: "rides", unique: true },
    longDistance: {
      enabled: { type: Boolean, default: false },
      /** A delivery longer than this many km (billable distance) carries the extra fee. */
      thresholdKm: { type: Number, default: 0, min: 0 },
      /** Added once to a delivery over the threshold. */
      flatNgn: { type: Number, default: 0, min: 0 },
      /** Added for each km beyond the threshold. */
      perKmNgn: { type: Number, default: 0, min: 0 },
    },
    updatedByName: { type: String, trim: true },
  },
  { timestamps: true },
);

export type RideSettingsDoc = InferSchemaType<typeof rideSettingsSchema> & { _id: string };

export const RideSettings: Model<RideSettingsDoc> =
  (models.RideSettings as Model<RideSettingsDoc>) ?? model<RideSettingsDoc>("RideSettings", rideSettingsSchema);
