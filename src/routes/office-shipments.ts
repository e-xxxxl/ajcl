import { Router } from "express";
import { z } from "zod";
import { ok, asyncHandler, parse, ApiError } from "../lib/api";
import { requireOffice, requireAdmin } from "../lib/auth/middleware";
import type { SessionClaims } from "../lib/auth/jwt";
import { connectToDatabase } from "../lib/db";
import { Shipment } from "../models/Shipment";
import {
  receiveSchema,
  confirmWeightSchema,
  sendQuoteSchema,
  markBookedSchema,
  refundSchema,
  cancelSchema,
} from "../lib/validation/shipment";
import {
  findShipmentByReference,
  receiveAtOffice,
  viewOfficeCode,
  confirmWeight,
  cancelShipment,
  setStatus,
  serializeMany,
  serializeOne,
  requiresManualQuote,
  type Actor,
} from "../lib/services/shipments";
import {
  fetchAndPriceRates,
  buildManualOption,
  bookWithTerminal,
  settlePrepaidAfterWeigh,
  syncTracking,
} from "../lib/services/shipment-terminal";
import { notifyCustomer } from "../lib/services/shipment-notify";
import { SHIPMENT_STATUSES, MAX_AUTO_QUOTE_KG, type ShipmentStatus } from "../config/shipping";
import { isTerminalConfigured } from "../lib/env";

/**
 * The shipments desk. Office Admins and admins both work here; refunds and booking retries
 * (which spend the carrier wallet) are admin-only.
 */
export const officeShipmentsRouter = Router();

function actorOf(session: SessionClaims): Actor {
  return { id: session.sub, name: session.name ?? "Staff", role: session.role === "office_admin" ? "office_admin" : "admin" };
}

const listSchema = z.object({
  status: z.string().optional(),
  q: z.string().trim().max(80).optional(),
  type: z.enum(["interstate", "international"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/** GET /api/office/shipments */
officeShipmentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    requireOffice(req);
    await connectToDatabase();
    const q = parse(listSchema, req.query);

    const filter: Record<string, unknown> = {};
    if (q.status && (SHIPMENT_STATUSES as readonly string[]).includes(q.status)) filter.status = q.status;
    if (q.type) filter.shipmentType = q.type;
    if (q.q) {
      const needle = q.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { reference: new RegExp(needle, "i") },
        { "sender.name": new RegExp(needle, "i") },
        { "receiver.name": new RegExp(needle, "i") },
        { "terminal.trackingNumber": new RegExp(needle, "i") },
      ];
    }

    const [docs, counts] = await Promise.all([
      Shipment.find(filter as never).sort({ createdAt: -1 }).limit(q.limit),
      Shipment.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    return ok(res, {
      shipments: await serializeMany(docs, { staff: true }),
      counts: Object.fromEntries(counts.map((c: { _id: string; n: number }) => [c._id, c.n])),
    });
  }),
);

/** GET /api/office/shipments/:reference */
officeShipmentsRouter.get(
  "/:reference",
  asyncHandler(async (req, res) => {
    requireOffice(req);
    const shipment = await findShipmentByReference(req.params.reference);
    return ok(res, { shipment: await serializeOne(shipment, { staff: true }) });
  }),
);

/** GET /api/office/shipments/:reference/office-code: the rider's handover code. Every view is logged. */
officeShipmentsRouter.get(
  "/:reference/office-code",
  asyncHandler(async (req, res) => {
    const session = requireOffice(req);
    const shipment = await findShipmentByReference(req.params.reference);
    if (shipment.handover.method !== "pickup") {
      throw new ApiError("This shipment is a customer drop-off, so there is no rider code.", 409);
    }
    if (["pickup_fee_pending", "cancelled"].includes(shipment.status)) {
      throw new ApiError("There is no active rider pickup for this shipment.", 409);
    }
    const result = await viewOfficeCode(shipment, actorOf(session));
    if (!result.code) throw new ApiError("The rider code is not ready yet.", 409);
    return ok(res, result);
  }),
);

/** POST /api/office/shipments/:reference/receive */
officeShipmentsRouter.post(
  "/:reference/receive",
  asyncHandler(async (req, res) => {
    const session = requireOffice(req);
    const { note } = parse(receiveSchema, req.body ?? {});
    const shipment = await findShipmentByReference(req.params.reference);
    await receiveAtOffice(shipment, actorOf(session), note);
    return ok(res, { shipment: await serializeOne(shipment, { staff: true }) });
  }),
);

/** POST /api/office/shipments/:reference/weight */
officeShipmentsRouter.post(
  "/:reference/weight",
  asyncHandler(async (req, res) => {
    const session = requireOffice(req);
    const input = parse(confirmWeightSchema, req.body);
    const shipment = await findShipmentByReference(req.params.reference);
    await confirmWeight(shipment, actorOf(session), input);
    const settled = shipment.prepaid ? await settlePrepaidAfterWeigh(shipment, actorOf(session)) : shipment;
    return ok(res, {
      shipment: await serializeOne(settled, { staff: true }),
      manualRequired: requiresManualQuote(shipment),
      maxAutoQuoteKg: MAX_AUTO_QUOTE_KG,
    });
  }),
);

/** POST /api/office/shipments/:reference/rates: fetch live carrier rates and price them. */
officeShipmentsRouter.post(
  "/:reference/rates",
  asyncHandler(async (req, res) => {
    requireOffice(req);
    const shipment = await findShipmentByReference(req.params.reference);
    if (!["weight_confirmed", "quote_sent"].includes(shipment.status)) {
      throw new ApiError("Weigh the package before fetching rates.", 409);
    }
    const result = await fetchAndPriceRates(shipment);
    return ok(res, { ...result, shipment: await serializeOne(shipment, { staff: true }) });
  }),
);

/** POST /api/office/shipments/:reference/quote: send the customer their options. */
officeShipmentsRouter.post(
  "/:reference/quote",
  asyncHandler(async (req, res) => {
    const session = requireOffice(req);
    const input = parse(sendQuoteSchema, req.body);
    const shipment = await findShipmentByReference(req.params.reference);
    if (!["weight_confirmed", "quote_sent"].includes(shipment.status)) {
      throw new ApiError("Weigh the package before sending a quote.", 409);
    }

    let options;
    if (requiresManualQuote(shipment)) {
      if (!input.manual) {
        throw new ApiError(`Parcels over ${MAX_AUTO_QUOTE_KG} kg are quoted by hand. Enter the amount.`, 422);
      }
      options = [buildManualOption(input.manual.amount, input.manual)];
    } else if (input.manual) {
      // Allowed when the carrier is unavailable; the office decides the price themselves.
      options = [buildManualOption(input.manual.amount, input.manual)];
    } else {
      const wanted = new Set(input.rateIds);
      options = shipment.quote.options.filter((o) => wanted.has(o.rateId) && !o.manual).map((o) => o.toObject());
      if (options.length === 0) throw new ApiError("Fetch rates first, then choose which options to send.", 422);
    }

    shipment.quote.options = options as never;
    shipment.quote.selectedRateId = undefined;
    shipment.quote.sentAt = new Date();
    shipment.quote.note = input.note;
    setStatus(shipment, "quote_sent", actorOf(session), input.note || "Quote sent to the customer");
    await shipment.save();

    const lowest = Math.min(...options.map((o) => o.total));
    await notifyCustomer(
      String(shipment.user),
      "shipment_quote_ready",
      "Your shipping quote is ready",
      `Shipment ${shipment.reference} has ${options.length === 1 ? "a delivery option" : `${options.length} delivery options`} from ₦${Math.round(lowest).toLocaleString("en-NG")}. Review and pay to ship.`,
      shipment.reference,
    );
    return ok(res, { shipment: await serializeOne(shipment, { staff: true }) });
  }),
);

/** POST /api/office/shipments/:reference/retry-booking: after the carrier wallet is funded. */
officeShipmentsRouter.post(
  "/:reference/retry-booking",
  asyncHandler(async (req, res) => {
    const session = requireAdmin(req);
    const shipment = await findShipmentByReference(req.params.reference);
    if (shipment.status !== "booking_failed" && shipment.status !== "paid") {
      throw new ApiError("Only a paid shipment that is not yet booked can be retried.", 409);
    }
    const booked = await bookWithTerminal(String(shipment._id), actorOf(session));
    return ok(res, { shipment: await serializeOne(booked, { staff: true }) });
  }),
);

/** POST /api/office/shipments/:reference/mark-booked: for hand-quoted shipments booked outside Terminal. */
officeShipmentsRouter.post(
  "/:reference/mark-booked",
  asyncHandler(async (req, res) => {
    const session = requireOffice(req);
    const input = parse(markBookedSchema, req.body);
    const shipment = await findShipmentByReference(req.params.reference);
    const option = shipment.quote.options.find((o) => o.rateId === shipment.quote.selectedRateId);
    if (shipment.status !== "paid" || !option?.manual) {
      throw new ApiError("Only a paid, hand-quoted shipment is booked manually.", 409);
    }
    shipment.terminal.carrierName = input.carrierName;
    shipment.terminal.trackingNumber = input.trackingNumber;
    shipment.terminal.trackingUrl = input.trackingUrl || undefined;
    shipment.terminal.bookedAt = new Date();
    setStatus(shipment, "booked", actorOf(session), `Booked manually with ${input.carrierName}`);
    await shipment.save();
    await notifyCustomer(
      String(shipment.user),
      "shipment_booked",
      "Your shipment is booked",
      `Shipment ${shipment.reference} is booked with ${input.carrierName}. Tracking number: ${input.trackingNumber}.`,
      shipment.reference,
    );
    return ok(res, { shipment: await serializeOne(shipment, { staff: true }) });
  }),
);

/** POST /api/office/shipments/:reference/status: move a booked, hand-run shipment along. */
officeShipmentsRouter.post(
  "/:reference/status",
  asyncHandler(async (req, res) => {
    const session = requireOffice(req);
    const { status } = parse(z.object({ status: z.enum(["in_transit", "delivered"]) }), req.body);
    const shipment = await findShipmentByReference(req.params.reference);
    const order: ShipmentStatus[] = ["booked", "in_transit", "delivered"];
    if (!shipment.terminal.bookedAt || order.indexOf(shipment.status as ShipmentStatus) < 0 || order.indexOf(status) <= order.indexOf(shipment.status as ShipmentStatus)) {
      throw new ApiError("That update does not follow from the shipment's current status.", 409);
    }
    if (shipment.terminal.shipmentId) {
      throw new ApiError("This shipment is tracked automatically by the carrier.", 409);
    }
    setStatus(shipment, status, actorOf(session));
    await shipment.save();
    await notifyCustomer(
      String(shipment.user),
      status === "delivered" ? "shipment_delivered" : "shipment_in_transit",
      status === "delivered" ? "Your shipment was delivered" : "Your shipment is on its way",
      `Shipment ${shipment.reference} is now ${status === "delivered" ? "delivered" : "in transit"}.`,
      shipment.reference,
    );
    return ok(res, { shipment: await serializeOne(shipment, { staff: true }) });
  }),
);

/** POST /api/office/shipments/:reference/sync: pull carrier tracking now. */
officeShipmentsRouter.post(
  "/:reference/sync",
  asyncHandler(async (req, res) => {
    requireOffice(req);
    const shipment = await findShipmentByReference(req.params.reference);
    if (!isTerminalConfigured) throw new ApiError("Terminal Africa is not configured.", 503);
    await syncTracking(shipment);
    return ok(res, { shipment: await serializeOne(shipment, { staff: true }) });
  }),
);

/** POST /api/office/shipments/:reference/cancel */
officeShipmentsRouter.post(
  "/:reference/cancel",
  asyncHandler(async (req, res) => {
    const session = requireOffice(req);
    const { reason } = parse(cancelSchema, req.body ?? {});
    const shipment = await findShipmentByReference(req.params.reference);
    await cancelShipment(shipment, actorOf(session), reason);
    return ok(res, { shipment: await serializeOne(shipment, { staff: true }) });
  }),
);

/**
 * POST /api/office/shipments/:reference/refund: record that the pickup fee was refunded by hand.
 * Nothing is paid out from here today; the record is built so an automatic Paystack refund can
 * be wired in at this spot later.
 */
officeShipmentsRouter.post(
  "/:reference/refund",
  asyncHandler(async (req, res) => {
    const session = requireAdmin(req);
    const input = parse(refundSchema, req.body);
    const shipment = await findShipmentByReference(req.params.reference);
    const key = input.target === "shipping" ? "shipping" : "pickupFee";
    if (input.target === "pickup_fee" && shipment.handover.method !== "pickup") {
      throw new ApiError("This shipment had no pickup fee.", 409);
    }
    if (input.target === "shipping" && !shipment.shippingPaidAt) {
      throw new ApiError("The shipping total has not been paid, so there is nothing to refund.", 409);
    }
    if (shipment.refund?.[key]?.amount != null) throw new ApiError("A refund is already recorded for that payment.", 409);

    shipment.set(`refund.${key}`, {
      amount: input.amount,
      reason: input.reason,
      reference: input.reference,
      markedAt: new Date(),
      by: session.sub,
      byName: session.name ?? "Admin",
    });
    await shipment.save();
    await notifyCustomer(
      String(shipment.user),
      "shipment_failed",
      "Refund recorded",
      `A refund of ₦${Math.round(input.amount).toLocaleString("en-NG")} was recorded for shipment ${shipment.reference} (${input.target === "shipping" ? "shipping payment" : "pickup fee"}).`,
      shipment.reference,
    );
    return ok(res, { shipment: await serializeOne(shipment, { staff: true }) });
  }),
);
