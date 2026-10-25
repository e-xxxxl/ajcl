import { z } from "zod";
import { SHIPMENT_TYPES } from "../../config/shipping";
import { locationSchema, clientRouteSchema } from "./booking";
import { toInternationalPhone, phoneProblem } from "../phone";

const phone = z.string().trim().min(1, "Enter a phone number").max(30, "That phone number is too long");

/** Strict: the customer must give the country code. Stored as +2348031234567, the only form the carrier accepts. */
function internationalPhone<T extends { phone: string; country: string }>(p: T, ctx: z.RefinementCtx): T {
  const normalised = toInternationalPhone(p.phone, p.country, { strict: true });
  if (!normalised) {
    ctx.addIssue({ code: "custom", path: ["phone"], message: phoneProblem(p.country) });
    return p;
  }
  return { ...p, phone: normalised };
}

const country = z
  .string()
  .trim()
  .toUpperCase()
  .length(2, "Choose a country");

export const partySchema = z.object({
  name: z.string().trim().min(2, "Required").max(120),
  phone,
  email: z.string().trim().toLowerCase().email("Enter a valid email").or(z.literal("")).optional(),
  line1: z.string().trim().min(3, "Enter the street address").max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(2, "Required").max(100),
  state: z.string().trim().min(2, "Required").max(100),
  country,
  zip: z.string().trim().max(20).optional(),
}).transform(internationalPhone);

export const itemSchema = z.object({
  description: z.string().trim().min(2, "Describe the item").max(200),
  quantity: z.coerce.number().int().min(1).max(9999),
  /** Value of ONE unit, in naira. */
  value: z.coerce.number().min(0).max(1_000_000_000),
  hsCode: z
    .string()
    .trim()
    .regex(/^[0-9.]{4,15}$/, "An HS code is 4 to 10 digits")
    .optional()
    .or(z.literal("")),
});

const dimensionsSchema = z
  .object({
    lengthCm: z.coerce.number().min(0.1).max(500),
    widthCm: z.coerce.number().min(0.1).max(500),
    heightCm: z.coerce.number().min(0.1).max(500),
  })
  .partial()
  .optional();

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date");
const timeStr = z.string().regex(/^\d{2}:\d{2}$/, "Choose a time");

export const createShipmentSchema = z
  .object({
    shipmentType: z.enum(SHIPMENT_TYPES),
    sender: partySchema,
    receiver: partySchema,
    parcel: z.object({
      description: z.string().trim().min(3, "Describe the package").max(500),
      estimatedWeightKg: z.coerce.number().min(0.01, "Enter the weight").max(1000),
      dimensions: dimensionsSchema,
      declaredValue: z.coerce.number().min(0).max(1_000_000_000).default(0),
      items: z.array(itemSchema).max(30).default([]),
    }),
    handover: z.discriminatedUnion("method", [
      z.object({ method: z.literal("dropoff") }),
      z.object({
        method: z.literal("pickup"),
        /** The rider's trip to our office, priced and paid exactly like a normal booking. */
        pickup: z.object({
          location: locationSchema,
          scheduledDate: dateStr,
          scheduledTime: timeStr,
          vehicleSlug: z.string().trim().min(1, "Select a vehicle"),
          notes: z.string().trim().max(800).optional().default(""),
          clientRoute: clientRouteSchema,
        }),
      }),
    ]),
  })
  .superRefine((v, ctx) => {
    if (v.shipmentType === "interstate" && v.sender.country !== "NG") {
      ctx.addIssue({ code: "custom", path: ["sender", "country"], message: "Interstate shipments stay in Nigeria" });
    }
    if (v.shipmentType === "interstate" && v.receiver.country !== "NG") {
      ctx.addIssue({ code: "custom", path: ["receiver", "country"], message: "Interstate shipments stay in Nigeria" });
    }
    if (v.shipmentType === "international") {
      if (v.receiver.country === "NG") {
        ctx.addIssue({ code: "custom", path: ["receiver", "country"], message: "Choose a country outside Nigeria" });
      }
      if (!v.receiver.zip?.trim()) {
        ctx.addIssue({ code: "custom", path: ["receiver", "zip"], message: "Enter the postcode. The carrier needs it for international delivery" });
      }
      if (v.parcel.items.length === 0) {
        ctx.addIssue({ code: "custom", path: ["parcel", "items"], message: "List what is in the package for customs" });
      }
      if (!v.sender.email?.trim()) ctx.addIssue({ code: "custom", path: ["sender", "email"], message: "Enter the sender's email" });
      if (!v.receiver.email?.trim()) ctx.addIssue({ code: "custom", path: ["receiver", "email"], message: "Enter the receiver's email" });
    }
  });

export type CreateShipmentInput = z.infer<typeof createShipmentSchema>;

/** A shipment created by staff on the admin side: the parcel is already in hand, so there is no handover. */
export const staffCreateShipmentSchema = z
  .object({
    shipmentType: z.enum(SHIPMENT_TYPES),
    /** Put it on this customer's account. Leave empty to keep it on the staff member's own account. */
    customerEmail: z.string().trim().toLowerCase().email("Enter a valid email").or(z.literal("")).optional(),
    sender: partySchema,
    receiver: partySchema,
    parcel: z.object({
      description: z.string().trim().min(3, "Describe the package").max(500),
      /** The real weight, as measured by staff. */
      estimatedWeightKg: z.coerce.number().min(0.01, "Enter the weight").max(1000),
      dimensions: dimensionsSchema,
      declaredValue: z.coerce.number().min(0).max(1_000_000_000).default(0),
      items: z.array(itemSchema).max(30).default([]),
    }),
    note: z.string().trim().max(300).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.shipmentType === "interstate" && v.sender.country !== "NG") ctx.addIssue({ code: "custom", path: ["sender", "country"], message: "Interstate shipments stay in Nigeria" });
    if (v.shipmentType === "interstate" && v.receiver.country !== "NG") {
      ctx.addIssue({ code: "custom", path: ["receiver", "country"], message: "Interstate shipments stay in Nigeria" });
    }
    if (v.shipmentType === "international") {
      if (v.receiver.country === "NG") ctx.addIssue({ code: "custom", path: ["receiver", "country"], message: "Choose a country outside Nigeria" });
      if (!v.receiver.zip?.trim()) ctx.addIssue({ code: "custom", path: ["receiver", "zip"], message: "Enter the postcode. The carrier needs it for international delivery" });
      if (v.parcel.items.length === 0) ctx.addIssue({ code: "custom", path: ["parcel", "items"], message: "List what is in the package for customs" });
    }
  });

export type StaffCreateShipmentInput = z.infer<typeof staffCreateShipmentSchema>;

export const bookWithoutPaymentSchema = z.object({
  rateId: z.string().trim().min(1, "Choose a delivery option").optional(),
  note: z.string().trim().min(3, "Say how it was paid, or why it is not charged").max(300),
});

export const receiveSchema = z.object({ note: z.string().trim().max(500).optional() });

export const confirmWeightSchema = z.object({
  weightKg: z.coerce.number().min(0.01, "Enter the weight").max(1000),
  dimensions: dimensionsSchema,
  note: z.string().trim().max(500).optional(),
});

export const sendQuoteSchema = z
  .object({
    /** Which fetched carrier options the customer may choose from. */
    rateIds: z.array(z.string().trim().min(1)).max(20).optional(),
    /** Used instead of rateIds for parcels over the weight limit, or when Terminal is unavailable. */
    manual: z
      .object({
        amount: z.coerce.number().min(1, "Enter the amount").max(1_000_000_000),
        carrierName: z.string().trim().max(80).optional(),
        deliveryTime: z.string().trim().max(120).optional(),
      })
      .optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => (v.rateIds && v.rateIds.length > 0) || v.manual, {
    message: "Choose at least one option, or enter an amount",
  });

export const payShippingSchema = z.object({
  rateId: z.string().trim().min(1, "Choose an option"),
  /** Pay the rider's pickup fee in the same charge (international, before the pickup fee is paid). */
  includePickupFee: z.boolean().optional(),
});

export const markBookedSchema = z.object({
  carrierName: z.string().trim().min(2).max(80),
  trackingNumber: z.string().trim().min(2).max(120),
  trackingUrl: z.string().trim().url().max(400).optional().or(z.literal("")),
});

export const refundSchema = z.object({
  /** Which payment is being refunded. */
  target: z.enum(["pickup_fee", "shipping"]).default("pickup_fee"),
  amount: z.coerce.number().min(0).max(100_000_000),
  reason: z.string().trim().min(3, "Say why").max(500),
  reference: z.string().trim().max(120).optional(),
});

export const cancelSchema = z.object({ reason: z.string().trim().max(500).optional() });
