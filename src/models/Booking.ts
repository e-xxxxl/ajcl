import {
  Schema,
  model,
  models,
  type Model,
  type InferSchemaType,
  type HydratedDocument,
} from "mongoose";
import {
  BOOKING_STATUS_FLOW,
  DELIVERY_TYPES,
  PACKAGE_CATEGORIES,
} from "../config/booking";

/** A resolved place from Google (or manual entry). */
const locationSchema = new Schema(
  {
    formattedAddress: { type: String, required: true, trim: true, maxlength: 400 },
    lat: { type: Number },
    lng: { type: Number },
    placeId: { type: String, trim: true },
    /** Optional contact/label for this point. */
    label: { type: String, trim: true, maxlength: 120 },
    /** True when the address was typed manually (no Google resolution). */
    manual: { type: Boolean, default: false },
  },
  { _id: false },
);

const contactSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 30 },
    email: { type: String, trim: true, lowercase: true, maxlength: 160 },
  },
  { _id: false },
);

const packageSchema = new Schema(
  {
    description: { type: String, required: true, trim: true, maxlength: 500 },
    category: { type: String, enum: PACKAGE_CATEGORIES as unknown as string[], required: true },
    quantity: { type: Number, min: 1, default: 1 },
    declaredValue: { type: Number, min: 0, default: 0 },
    specialInstructions: { type: String, trim: true, maxlength: 800 },
  },
  { _id: false },
);

const pricingSchema = new Schema(
  {
    distanceKm: { type: Number, required: true, min: 0 },
    billableDistanceKm: { type: Number, required: true, min: 0 },
    estimatedDurationSeconds: { type: Number, required: true, min: 0 },
    pricePerKm: { type: Number, required: true, min: 0 },
    basePrice: { type: Number, required: true, min: 0, default: 0 },
    distanceCharge: { type: Number, required: true, min: 0 },
    stopsFee: { type: Number, required: true, min: 0, default: 0 },
    tax: { type: Number, required: true, min: 0, default: 0 },
    minimumFareApplied: { type: Boolean, default: false },
    subtotal: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "NGN" },
    /** Snapshot for audit — recomputed & verified server-side before payment. */
    computedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const paymentSchema = new Schema(
  {
    provider: { type: String, default: "paystack" },
    status: {
      type: String,
      enum: ["unpaid", "pending", "paid", "failed", "refunded"],
      default: "unpaid",
      index: true,
    },
    reference: { type: String, index: true },
    accessCode: { type: String },
    authorizationUrl: { type: String },
    amount: { type: Number, min: 0 },
    currency: { type: String, default: "NGN" },
    channel: { type: String },
    paidAt: { type: Date },
    rawVerification: { type: Schema.Types.Mixed, select: false },
  },
  { _id: false },
);

const statusEntrySchema = new Schema(
  {
    status: { type: String, required: true },
    note: { type: String, trim: true, maxlength: 500 },
    changedByRole: { type: String, enum: ["system", "customer", "admin"], default: "system" },
    changedBy: { type: Schema.Types.ObjectId, ref: "User" },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const bookingSchema = new Schema(
  {
    bookingReference: { type: String, required: true, unique: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    // ── Route ────────────────────────────────────────────────
    pickup: { type: locationSchema, required: true },
    stops: { type: [locationSchema], default: [] },
    destination: { type: locationSchema, required: true },
    deliveryType: {
      type: String,
      enum: Object.keys(DELIVERY_TYPES),
      default: "single",
      required: true,
    },

    // ── Schedule ─────────────────────────────────────────────
    scheduledDate: { type: String, required: true }, // YYYY-MM-DD
    scheduledTime: { type: String, required: true }, // HH:mm
    scheduledAt: { type: Date, required: true, index: true },

    // ── Route metrics (server-authoritative) ─────────────────
    distanceKm: { type: Number, default: 0 },
    estimatedDurationSeconds: { type: Number, default: 0 },
    routePolyline: { type: String },
    /** Full metrics snapshot — lets a re-price fall back to the values that were
     *  verified when the booking was created, if live routing is unavailable. */
    routeMeta: {
      distanceKm: { type: Number },
      returnLegKm: { type: Number },
      estimatedDurationSeconds: { type: Number },
      source: { type: String, enum: ["google", "estimate"] },
    },

    // ── Vehicle snapshot ─────────────────────────────────────
    vehicle: {
      vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true },
      slug: { type: String, required: true },
      name: { type: String, required: true },
      image: { type: String },
      pricePerKm: { type: Number, required: true },
    },

    // ── Parties & package ────────────────────────────────────
    sender: { type: contactSchema, required: true },
    recipient: { type: contactSchema, required: true },
    package: { type: packageSchema, required: true },
    notes: { type: String, trim: true, maxlength: 800 },

    // ── Money ────────────────────────────────────────────────
    pricing: { type: pricingSchema, required: true },
    payment: { type: paymentSchema, default: () => ({}) },

    // ── Lifecycle ────────────────────────────────────────────
    status: {
      type: String,
      enum: [...BOOKING_STATUS_FLOW, "cancelled"],
      default: "pending",
      index: true,
    },
    statusHistory: { type: [statusEntrySchema], default: [] },

    assignedDriver: {
      name: { type: String, trim: true },
      phone: { type: String, trim: true },
      plate: { type: String, trim: true, uppercase: true, maxlength: 20 },
    },

    cancelledReason: { type: String, trim: true, maxlength: 500 },
    confirmedAt: { type: Date },
    deliveredAt: { type: Date },
  },
  { timestamps: true },
);

bookingSchema.index({ createdAt: -1 });
bookingSchema.index({ user: 1, status: 1 });
bookingSchema.index({ status: 1, scheduledAt: 1 });

bookingSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.__v;
    if (ret.payment && typeof ret.payment === "object") {
      delete (ret.payment as Record<string, unknown>).rawVerification;
    }
    return ret;
  },
});

export type BookingDoc = InferSchemaType<typeof bookingSchema> & { _id: string };
export type BookingHydrated = HydratedDocument<BookingDoc>;
export type BookingLocation = InferSchemaType<typeof locationSchema>;

export const Booking: Model<BookingDoc> =
  (models.Booking as Model<BookingDoc>) ?? model<BookingDoc>("Booking", bookingSchema);
