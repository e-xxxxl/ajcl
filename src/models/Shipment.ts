import {
  Schema,
  model,
  models,
  type Model,
  type InferSchemaType,
  type HydratedDocument,
} from "mongoose";
import { SHIPMENT_STATUSES, SHIPMENT_TYPES } from "../config/shipping";

/** A person and where they are. Country is an ISO 2 code ("NG", "GB"), as Terminal Africa expects. */
const partySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 30 },
    email: { type: String, trim: true, lowercase: true, maxlength: 160 },
    line1: { type: String, required: true, trim: true, maxlength: 200 },
    line2: { type: String, trim: true, maxlength: 200 },
    city: { type: String, required: true, trim: true, maxlength: 100 },
    state: { type: String, required: true, trim: true, maxlength: 100 },
    country: { type: String, required: true, trim: true, uppercase: true, minlength: 2, maxlength: 2 },
    zip: { type: String, trim: true, maxlength: 20 },
  },
  { _id: false },
);

const itemSchema = new Schema(
  {
    description: { type: String, required: true, trim: true, maxlength: 200 },
    quantity: { type: Number, required: true, min: 1, default: 1 },
    /** Value of ONE unit, in `currency`. */
    value: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "NGN", trim: true, uppercase: true, maxlength: 3 },
    /** Harmonised System code, optional. Used for customs on international parcels. */
    hsCode: { type: String, trim: true, maxlength: 20 },
  },
  { _id: false },
);

const dimensionsSchema = new Schema(
  {
    lengthCm: { type: Number, min: 0.1, max: 500 },
    widthCm: { type: Number, min: 0.1, max: 500 },
    heightCm: { type: Number, min: 0.1, max: 500 },
  },
  { _id: false },
);

/** One carrier option, priced. The Office Admin chooses which of these the customer sees. */
const quoteOptionSchema = new Schema(
  {
    rateId: { type: String, required: true },
    carrierName: { type: String, required: true },
    carrierLogo: { type: String },
    service: { type: String },
    deliveryTime: { type: String },
    /** What Terminal quoted, in its currency. */
    sourceAmount: { type: Number, required: true, min: 0 },
    sourceCurrency: { type: String, required: true, default: "NGN" },
    /** NGN per 1 unit of sourceCurrency at the time (1 for NGN). Stored so old quotes never change. */
    fxRate: { type: Number, required: true, default: 1 },
    /** When that rate was last set by the Super Admin (shown as "rate last updated"). */
    fxRateUpdatedAt: { type: Date },
    /** Base carrier rate in naira, before AJCL markup. */
    baseRate: { type: Number, required: true, min: 0 },
    tierPercent: { type: Number, required: true, default: 0 },
    markup: { type: Number, required: true, default: 0 },
    flatFee: { type: Number, required: true, default: 0 },
    surcharge: { type: Number, required: true, default: 0 },
    total: { type: Number, required: true, min: 0 },
    /** Entered by hand (over the weight limit, or Terminal unavailable). */
    manual: { type: Boolean, default: false },
    /** A price shown before the parcel is weighed. It cannot be booked: the real rate is fetched after weighing. */
    estimated: { type: Boolean, default: false },
  },
  { _id: false },
);

const statusEntrySchema = new Schema(
  {
    status: { type: String, required: true },
    note: { type: String, trim: true, maxlength: 500 },
    byRole: { type: String, enum: ["system", "customer", "admin", "office_admin", "rider", "carrier"], default: "system" },
    byName: { type: String, trim: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const trackingEventSchema = new Schema(
  {
    eventId: { type: String },
    status: { type: String, required: true },
    description: { type: String, trim: true, maxlength: 500 },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const shipmentSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true, index: true },
    shipmentType: { type: String, enum: SHIPMENT_TYPES as unknown as string[], required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    sender: { type: partySchema, required: true },
    receiver: { type: partySchema, required: true },

    parcel: {
      description: { type: String, required: true, trim: true, maxlength: 500 },
      estimatedWeightKg: { type: Number, required: true, min: 0.01, max: 1000 },
      dimensions: { type: dimensionsSchema, default: () => ({}) },
      declaredValue: { type: Number, min: 0, default: 0 },
      items: { type: [itemSchema], default: [] },
    },

    handover: {
      method: { type: String, enum: ["pickup", "dropoff"], required: true },
      /** The local booking (kind: shipment_pickup) that brings the package to our office. */
      pickupBooking: { type: Schema.Types.ObjectId, ref: "Booking", index: true },
      receivedAt: { type: Date },
      receivedBy: { type: Schema.Types.ObjectId, ref: "User" },
      receivedByName: { type: String, trim: true },
      /** Every time an admin viewed the office handover code (audit). */
      officeCodeViews: {
        type: [new Schema({ by: { type: Schema.Types.ObjectId, ref: "User" }, byName: String, at: { type: Date, default: Date.now } }, { _id: false })],
        default: [],
      },
    },

    /** What the Office Admin measured. Overrides the customer's estimate. */
    confirmed: {
      weightKg: { type: Number, min: 0.01, max: 1000 },
      dimensions: { type: dimensionsSchema, default: () => ({}) },
      note: { type: String, trim: true, maxlength: 500 },
      by: { type: Schema.Types.ObjectId, ref: "User" },
      byName: { type: String, trim: true },
      at: { type: Date },
    },

    quote: {
      /** Options the customer can choose from (a subset of what Terminal returned). */
      options: { type: [quoteOptionSchema], default: [] },
      selectedRateId: { type: String },
      /** International: prices were fetched on the customer's own weight so they can pay before it is weighed. */
      prepayOffered: { type: Boolean, default: false },
      /** Why carrier prices could not be loaded at creation (staff see it; customers get a plain retry). */
      prepayError: { type: String, trim: true, maxlength: 300 },
      /** The carrier the customer chose when paying in advance; after weighing we price the same one. */
      prepaidCarrier: { type: String },
      /** Weight the quote was priced on, after rounding up. */
      billedWeightKg: { type: Number },
      sentAt: { type: Date },
      selectedAt: { type: Date },
      note: { type: String, trim: true, maxlength: 500 },
    },

    terminal: {
      pickupAddressId: { type: String },
      deliveryAddressId: { type: String },
      packagingId: { type: String },
      parcelId: { type: String },
      /** Terminal's shipment id (SH-...). A draft until it is booked. */
      shipmentId: { type: String, index: true, sparse: true },
      rateId: { type: String },
      carrierName: { type: String },
      trackingNumber: { type: String },
      trackingUrl: { type: String },
      status: { type: String },
      bookedAt: { type: Date },
      lastSyncedAt: { type: Date },
      bookingError: { type: String, trim: true, maxlength: 500 },
      /** Claimed while a booking call is in flight, so two requests never book (and charge) twice. */
      bookingLockAt: { type: Date },
      /** The carrier cancelled the shipment and the money went back to the Terminal wallet. Booking again needs a fresh rate. */
      rebookRequired: { type: Boolean },
      events: { type: [trackingEventSchema], default: [] },
    },

    /** Set when staff created this shipment on the admin side (walk-in, phone or repeat customer). */
    createdByStaff: {
      by: { type: Schema.Types.ObjectId, ref: "User" },
      name: { type: String, trim: true },
    },
    /** Booked by an admin without an online payment (paid by transfer or cash, or not charged). */
    offlinePayment: {
      note: { type: String, trim: true, maxlength: 300 },
      by: { type: Schema.Types.ObjectId, ref: "User" },
      byName: { type: String, trim: true },
      at: { type: Date },
    },
    /** The customer paid for shipping before the parcel was weighed (international). Any difference is settled after. */
    prepaid: { type: Boolean, default: false },
    shippingPaidAt: { type: Date },
    shippingAmount: { type: Number, min: 0 },

    /** Manual refunds, recorded by an admin after paying the money back outside the app. */
    refund: {
      pickupFee: {
        amount: { type: Number, min: 0 },
        reason: { type: String, trim: true, maxlength: 500 },
        reference: { type: String, trim: true, maxlength: 120 },
        markedAt: { type: Date },
        by: { type: Schema.Types.ObjectId, ref: "User" },
        byName: { type: String, trim: true },
      },
      shipping: {
        amount: { type: Number, min: 0 },
        reason: { type: String, trim: true, maxlength: 500 },
        reference: { type: String, trim: true, maxlength: 120 },
        markedAt: { type: Date },
        by: { type: Schema.Types.ObjectId, ref: "User" },
        byName: { type: String, trim: true },
      },
    },

    status: {
      type: String,
      enum: SHIPMENT_STATUSES as unknown as string[],
      required: true,
      index: true,
    },
    statusHistory: { type: [statusEntrySchema], default: [] },
    cancelledReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

shipmentSchema.index({ user: 1, createdAt: -1 });
shipmentSchema.index({ status: 1, createdAt: -1 });

type ShipmentSchemaDoc = InferSchemaType<typeof shipmentSchema>;
/** Nested groups always exist on a stored shipment (Mongoose fills them in), so don't make callers null-check them. */
export type ShipmentDoc = Omit<ShipmentSchemaDoc, "quote" | "terminal" | "parcel" | "handover"> & {
  quote: NonNullable<ShipmentSchemaDoc["quote"]>;
  terminal: NonNullable<ShipmentSchemaDoc["terminal"]>;
  parcel: NonNullable<ShipmentSchemaDoc["parcel"]>;
  handover: NonNullable<ShipmentSchemaDoc["handover"]>;
  _id: string;
};
export type ShipmentHydrated = HydratedDocument<ShipmentDoc>;

export const Shipment: Model<ShipmentDoc> =
  (models.Shipment as Model<ShipmentDoc>) ?? model<ShipmentDoc>("Shipment", shipmentSchema);
