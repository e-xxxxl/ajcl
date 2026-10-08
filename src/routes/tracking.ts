import { Router } from "express";
import { connectToDatabase } from "../lib/db";
import { ok, asyncHandler, ApiError } from "../lib/api";
import { enforceRateLimit } from "../lib/rate-limit";
import { Booking } from "../models/Booking";
import type { TrackingDTO } from "../types";

export const trackingRouter = Router();

/**
 * GET /api/track/:token — public, no login. The receiver's view of a delivery:
 * live status, rider contact once assigned, and their own delivery code.
 * Never exposes price, payment, the sender's pickup code, or anyone's email.
 */
trackingRouter.get(
  "/:token",
  asyncHandler(async (req, res) => {
    enforceRateLimit(req, "tracking", { limit: 60, windowMs: 10 * 60 * 1000 });
    await connectToDatabase();

    const token = req.params.token?.trim();
    if (!token) throw new ApiError("Tracking link not found.", 404);

    const booking = await Booking.findOne({ "handover.trackingToken": token })
      .select("+handover.trackingToken +handover.deliveryCode")
      .lean();
    if (!booking) throw new ApiError("Tracking link not found.", 404);

    const loc = (l: typeof booking.pickup) => ({
      formattedAddress: l?.formattedAddress ?? "",
      lat: l?.lat ?? undefined,
      lng: l?.lng ?? undefined,
    });

    const dto: TrackingDTO = {
      bookingReference: booking.bookingReference,
      status: booking.status as TrackingDTO["status"],
      recipientName: booking.recipient?.name ?? "",
      pickup: loc(booking.pickup),
      destination: loc(booking.destination),
      vehicleName: booking.vehicle?.name ?? "",
      scheduledDate: booking.scheduledDate,
      scheduledTime: booking.scheduledTime,
      rider:
        booking.assignedDriver &&
        (booking.assignedDriver.name || booking.assignedDriver.phone || booking.assignedDriver.plate)
          ? {
              name: booking.assignedDriver.name ?? undefined,
              phone: booking.assignedDriver.phone ?? undefined,
              plate: booking.assignedDriver.plate ?? undefined,
            }
          : undefined,
      statusHistory: (booking.statusHistory ?? [])
        .filter((s) => s.status !== "pending")
        .map((s) => ({ status: s.status as TrackingDTO["status"], at: new Date(s.at as unknown as string).toISOString() })),
      deliveryCode: booking.handover?.deliveryCodeUsedAt ? undefined : booking.handover?.deliveryCode ?? undefined,
      deliveryUsedAt: booking.handover?.deliveryCodeUsedAt
        ? new Date(booking.handover.deliveryCodeUsedAt).toISOString()
        : undefined,
      deliveryLocked: booking.handover?.deliveryLocked ?? false,
    };

    return ok(res, { tracking: dto });
  }),
);
