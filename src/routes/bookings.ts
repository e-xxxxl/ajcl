import { Router } from "express";
import { connectToDatabase } from "../lib/db";
import { ok, asyncHandler, parse, ApiError } from "../lib/api";
import { requireSession } from "../lib/auth/middleware";
import { enforceRateLimit } from "../lib/rate-limit";
import {
  priceQuoteSchema,
  createBookingSchema,
  assertRoutable,
} from "../lib/validation/booking";
import { buildQuote } from "../lib/services/quote";
import { createBooking, changeBookingStatus } from "../lib/services/booking";
import { serializeBooking } from "../lib/serialize";
import { Booking } from "../models/Booking";

export const bookingsRouter = Router();

/** POST /api/bookings/quote — server-authoritative price quote. */
bookingsRouter.post(
  "/quote",
  asyncHandler(async (req, res) => {
    requireSession(req);
    enforceRateLimit(req, "quote", { limit: 40, windowMs: 60 * 1000 });

    const { clientRoute, ...input } = parse(priceQuoteSchema, req.body);
    try {
      assertRoutable(input);
    } catch (e) {
      throw new ApiError((e as Error).message, 422);
    }

    const quote = await buildQuote(input, { clientRoute });
    return ok(res, quote);
  }),
);

/** GET /api/bookings — the current user's bookings. */
bookingsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const session = requireSession(req);
    await connectToDatabase();

    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const query: Record<string, unknown> = { user: session.sub };
    if (status) query.status = status;

    const bookings = await Booking.find(query).sort({ createdAt: -1 }).limit(100).lean();
    return ok(res, { bookings: bookings.map((b) => serializeBooking(b)) });
  }),
);

/** POST /api/bookings — create a booking (status: pending, payment: unpaid). */
bookingsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const session = requireSession(req);
    enforceRateLimit(req, "create-booking", { limit: 20, windowMs: 60 * 60 * 1000 });

    const input = parse(createBookingSchema, req.body);
    try {
      assertRoutable(input);
    } catch (e) {
      throw new ApiError((e as Error).message, 422);
    }

    const booking = await createBooking(session.sub, input);
    return ok(res, { booking: serializeBooking(booking.toObject()) }, 201);
  }),
);

/** GET /api/bookings/:reference — one of the current user's bookings. */
bookingsRouter.get(
  "/:reference",
  asyncHandler(async (req, res) => {
    const session = requireSession(req);
    await connectToDatabase();

    const booking = await Booking.findOne({
      bookingReference: req.params.reference.toUpperCase(),
    }).lean();
    if (!booking) throw new ApiError("Booking not found.", 404);
    if (String(booking.user) !== session.sub && session.role !== "admin") {
      throw new ApiError("Booking not found.", 404); // don't leak existence
    }

    return ok(res, { booking: serializeBooking(booking) });
  }),
);

/** PATCH /api/bookings/:reference — customer-initiated cancel. */
bookingsRouter.patch(
  "/:reference",
  asyncHandler(async (req, res) => {
    const session = requireSession(req);
    await connectToDatabase();

    const body = (req.body ?? {}) as { action?: string; reason?: string };
    if (body.action !== "cancel") throw new ApiError("Unsupported action.", 400);

    const booking = await Booking.findOne({
      bookingReference: req.params.reference.toUpperCase(),
    });
    if (!booking || String(booking.user) !== session.sub) {
      throw new ApiError("Booking not found.", 404);
    }
    if (!["pending", "confirmed"].includes(booking.status)) {
      throw new ApiError("This booking can no longer be cancelled. Contact support.", 409);
    }

    const updated = await changeBookingStatus({
      bookingId: String(booking._id),
      to: "cancelled",
      note: body.reason?.slice(0, 300) || "Cancelled by customer",
      actorRole: "customer",
      actorId: session.sub,
      force: true,
    });

    return ok(res, { booking: serializeBooking(updated.toObject()) });
  }),
);
