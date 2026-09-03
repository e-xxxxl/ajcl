import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

const vehicleSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, required: true, trim: true, maxlength: 400 },
    image: { type: String, default: "" },
    capacity: { type: String, default: "" },

    /** Pricing — all admin-editable. */
    pricePerKm: { type: Number, required: true, min: 0, default: 0 },
    basePrice: { type: Number, required: true, min: 0, default: 0 },
    minimumFare: { type: Number, required: true, min: 0, default: 0 },

    /** Used to estimate ETA when the Routes API is unavailable. */
    averageSpeedKmh: { type: Number, required: true, min: 1, default: 24 },

    /**
     * How many units of this class the operator runs. A class is unavailable
     * for new bookings once this many are already on active deliveries.
     * 0 = unlimited (no capacity cap).
     */
    fleetSize: { type: Number, required: true, min: 0, default: 0 },

    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

vehicleSchema.set("toJSON", {
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.__v;
    return ret;
  },
});

export type VehicleDoc = InferSchemaType<typeof vehicleSchema> & { _id: string };

export const Vehicle: Model<VehicleDoc> =
  (models.Vehicle as Model<VehicleDoc>) ?? model<VehicleDoc>("Vehicle", vehicleSchema);
