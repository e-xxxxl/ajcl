import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";
import {
  DEFAULT_FLAT_FEE_NGN,
  DEFAULT_SURCHARGE_NGN,
  DEFAULT_WALLET_ALERT_NGN,
  DEFAULT_MARKUP_TIERS,
  DEFAULT_DISCLAIMER,
  DEFAULT_DUTIES_NOTICE,
  DEFAULT_REFUND_POLICY,
} from "../config/shipping";

/**
 * Everything the Super Admin can change about shipping. One document (key "default").
 * Nothing in here is hard-coded in the pricing logic: tiers, fees, rates and policy
 * text are all read from this record.
 */
const tierSchema = new Schema(
  {
    minKg: { type: Number, required: true, min: 1 },
    maxKg: { type: Number, required: true, min: 1 },
    percent: { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false },
);

const shippingSettingsSchema = new Schema(
  {
    key: { type: String, default: "default", unique: true },

    markupTiers: { type: [tierSchema], default: () => DEFAULT_MARKUP_TIERS.map((t) => ({ ...t })) },
    flatFeeNgn: { type: Number, default: DEFAULT_FLAT_FEE_NGN, min: 0 },
    surchargeNgn: { type: Number, default: DEFAULT_SURCHARGE_NGN, min: 0 },

    /** NGN per 1 unit of a foreign currency, e.g. { USD: 1500 }. Applied BEFORE the markup. */
    exchangeRates: { type: Map, of: Number, default: () => ({}) },
    exchangeRatesUpdatedAt: { type: Date },
    /** Currency to ask Terminal for on international shipments (converted to NGN with the rate above). */
    internationalQuoteCurrency: { type: String, default: "USD", uppercase: true, trim: true, maxlength: 3 },

    walletAlertThresholdNgn: { type: Number, default: DEFAULT_WALLET_ALERT_NGN, min: 0 },
    wallet: {
      balanceNgn: { type: Number },
      checkedAt: { type: Date },
      lastAlertAt: { type: Date },
      error: { type: String },
    },

    refundPolicyText: { type: String, default: DEFAULT_REFUND_POLICY, maxlength: 3000 },
    dutiesNotice: { type: String, default: DEFAULT_DUTIES_NOTICE, maxlength: 600 },
    disclaimerParagraphs: { type: [String], default: () => [...DEFAULT_DISCLAIMER] },

    /** Our office: where parcels are dropped off, and the carrier's pickup address for every shipment. */
    office: {
      name: { type: String, default: "AJ Courier & Logistics", trim: true },
      contactName: { type: String, default: "Office desk", trim: true },
      phone: { type: String, default: "", trim: true },
      email: { type: String, default: "", trim: true },
      line1: { type: String, default: "", trim: true },
      line2: { type: String, default: "", trim: true },
      city: { type: String, default: "Lagos", trim: true },
      state: { type: String, default: "Lagos", trim: true },
      country: { type: String, default: "NG", trim: true, uppercase: true },
      zip: { type: String, default: "", trim: true },
      lat: { type: Number },
      lng: { type: Number },
      openingHours: { type: String, default: "Monday to Saturday, 9:00am to 5:00pm", trim: true },
    },
  },
  { timestamps: true },
);

type SettingsSchemaDoc = InferSchemaType<typeof shippingSettingsSchema>;
export type ShippingSettingsDoc = Omit<SettingsSchemaDoc, "office"> & {
  office: NonNullable<SettingsSchemaDoc["office"]>;
  _id: string;
};

export const ShippingSettings: Model<ShippingSettingsDoc> =
  (models.ShippingSettings as Model<ShippingSettingsDoc>) ??
  model<ShippingSettingsDoc>("ShippingSettings", shippingSettingsSchema);
