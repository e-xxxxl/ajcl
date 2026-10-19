import { Router } from "express";
import { z } from "zod";
import { ok, asyncHandler, parse, ApiError } from "../lib/api";
import { requireSession } from "../lib/auth/middleware";
import { enforceRateLimit } from "../lib/rate-limit";
import { connectToDatabase } from "../lib/db";
import { Shipment } from "../models/Shipment";
import { env } from "../lib/env";
import { createShipmentSchema, payShippingSchema, cancelSchema } from "../lib/validation/shipment";
import {
  createShipmentRequest,
  findOwnShipment,
  cancelShipment,
  serializeMany,
  serializeOne,
} from "../lib/services/shipments";
import { getShippingSettings } from "../lib/services/shipping-settings";
import { initializeShippingPayment } from "../lib/services/shipment-payment";
import { estimateRates, syncTracking } from "../lib/services/shipment-terminal";
import { resolveLocation } from "../lib/services/locations";
import { MAX_AUTO_QUOTE_KG } from "../config/shipping";

export const shipmentsRouter = Router();

/** The office a customer drops parcels at, plus the policy text shown at checkout. Public. */
export async function publicShippingConfig() {
  const s = await getShippingSettings();
  const o = s.office;
  return {
    office: {
      name: o.name,
      phone: o.phone,
      email: o.email,
      line1: o.line1,
      line2: o.line2,
      city: o.city,
      state: o.state,
      zip: o.zip,
      lat: o.lat ?? null,
      lng: o.lng ?? null,
      openingHours: o.openingHours,
    },
    pickupAvailable: Boolean(o.line1 && o.phone),
    refundPolicyText: s.refundPolicyText,
    dutiesNotice: s.dutiesNotice,
    disclaimerParagraphs: s.disclaimerParagraphs,
    maxAutoQuoteKg: MAX_AUTO_QUOTE_KG,
  };
}

/** GET /api/shipments/config */
shipmentsRouter.get(
  "/config",
  asyncHandler(async (_req, res) => {
    await connectToDatabase();
    return ok(res, await publicShippingConfig());
  }),
);

const estimateSchema = z.object({
  shipmentType: z.enum(["interstate", "international"]),
  country: z.string().trim().toUpperCase().length(2),
  state: z.string().trim().min(2).max(100),
  city: z.string().trim().min(2).max(100),
  weightKg: z.coerce.number().min(0.1).max(1000),
  dimensions: z
    .object({
      lengthCm: z.coerce.number().min(1).max(300),
      widthCm: z.coerce.number().min(1).max(300),
      heightCm: z.coerce.number().min(1).max(300),
    })
    .optional(),
});

/** POST /api/shipments/estimate: carrier options for the public quote form. No account needed. */
shipmentsRouter.post(
  "/estimate",
  asyncHandler(async (req, res) => {
    enforceRateLimit(req, "shipment-estimate", { limit: 8, windowMs: 60 * 60 * 1000 });
    const input = parse(estimateSchema, req.body);
    if (input.shipmentType === "interstate" && input.country !== "NG") {
      throw new ApiError("Interstate shipments stay in Nigeria.", 422);
    }
    if (input.shipmentType === "international" && input.country === "NG") {
      throw new ApiError("Choose a country outside Nigeria for an international quote.", 422);
    }
    await connectToDatabase();
    const place = await resolveLocation({ country: input.country, state: input.state, city: input.city }, "destination");
    const result = await estimateRates({ ...input, country: place.country, state: place.state, city: place.city });
    return ok(res, {
      manualRequired: result.manualRequired,
      billedWeightKg: result.billedWeightKg,
      fxUpdatedAt: result.fxUpdatedAt,
      options: result.options.map((o) => ({
        rateId: o.rateId,
        carrierName: o.carrierName,
        carrierLogo: o.carrierLogo,
        deliveryTime: o.deliveryTime,
        total: o.total,
      })),
    });
  }),
);

/** POST /api/shipments: create a shipment (and, for pickup, its rider booking). */
shipmentsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const session = requireSession(req);
    enforceRateLimit(req, "shipment-create", { limit: 30, windowMs: 10 * 60 * 1000 });
    const input = parse(createShipmentSchema, req.body);
    const shipment = await createShipmentRequest(session.sub, input);
    return ok(res, { shipment: await serializeOne(shipment) }, 201);
  }),
);

/** GET /api/shipments: the signed-in customer's shipments. */
shipmentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const session = requireSession(req);
    await connectToDatabase();
    const docs = await Shipment.find({ user: session.sub }).sort({ createdAt: -1 }).limit(100);
    return ok(res, { shipments: await serializeMany(docs) });
  }),
);

/** GET /api/shipments/:reference */
shipmentsRouter.get(
  "/:reference",
  asyncHandler(async (req, res) => {
    const session = requireSession(req);
    const shipment = await findOwnShipment(session.sub, req.params.reference);
    return ok(res, { shipment: await serializeOne(shipment) });
  }),
);

/** POST /api/shipments/:reference/pay: pay the shipping total for the chosen option. */
shipmentsRouter.post(
  "/:reference/pay",
  asyncHandler(async (req, res) => {
    const session = requireSession(req);
    enforceRateLimit(req, "shipment-pay", { limit: 15, windowMs: 10 * 60 * 1000 });
    const { rateId } = parse(payShippingSchema, req.body);
    const result = await initializeShippingPayment(session.sub, req.params.reference, rateId);
    return ok(res, { ...result, provider: "paystack" });
  }),
);

/** POST /api/shipments/:reference/refresh: pull the latest carrier tracking now. */
shipmentsRouter.post(
  "/:reference/refresh",
  asyncHandler(async (req, res) => {
    const session = requireSession(req);
    enforceRateLimit(req, "shipment-refresh", { limit: 20, windowMs: 10 * 60 * 1000 });
    const shipment = await findOwnShipment(session.sub, req.params.reference);
    if (env.terminal.secretKey) await syncTracking(shipment);
    return ok(res, { shipment: await serializeOne(shipment) });
  }),
);

/** POST /api/shipments/:reference/cancel */
shipmentsRouter.post(
  "/:reference/cancel",
  asyncHandler(async (req, res) => {
    const session = requireSession(req);
    const { reason } = parse(cancelSchema, req.body ?? {});
    const shipment = await findOwnShipment(session.sub, req.params.reference);
    await cancelShipment(shipment, { id: session.sub, name: session.name ?? "Customer", role: "customer" }, reason);
    return ok(res, { shipment: await serializeOne(shipment) });
  }),
);
