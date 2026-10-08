import crypto from "node:crypto";
import { Booking, type BookingHydrated } from "../../models/Booking";
import { generateHandoverCode } from "../utils";
import type { BookingStatus } from "../../config/booking";

/** Statuses where a booking's codes are still "live" — used to avoid collisions. */
const ACTIVE_STATUSES: BookingStatus[] = ["pending", "confirmed", "driver_assigned", "in_transit"];

async function uniqueCode(): Promise<string> {
  for (let i = 0; i < 8; i += 1) {
    const code = generateHandoverCode();
    const clash = await Booking.exists({
      status: { $in: ACTIVE_STATUSES },
      $or: [{ "handover.pickupCode": code }, { "handover.deliveryCode": code }],
    });
    if (!clash) return code;
  }
  // Astronomically unlikely with 1M code space and a handful of active orders —
  // fall back to a wider draw so we never loop forever.
  return `${generateHandoverCode()}${Math.floor(Math.random() * 10)}`.slice(0, 6);
}

/**
 * Generate this booking's pickup code, delivery code and tracking token.
 * Idempotent — a booking that already has codes is left untouched, so it's
 * safe to call from both the payment callback and the webhook.
 */
export async function ensureHandoverCodes(booking: BookingHydrated): Promise<void> {
  const existing = await Booking.findById(booking._id).select("+handover.pickupCode").lean();
  if (existing?.handover?.pickupCode) return;

  const pickupCode = await uniqueCode();
  let deliveryCode = await uniqueCode();
  // Codes on the same order must differ from each other too.
  while (deliveryCode === pickupCode) {
    deliveryCode = await uniqueCode();
  }
  const trackingToken = crypto.randomBytes(24).toString("base64url");

  booking.set("handover", {
    pickupCode,
    pickupAttempts: 0,
    pickupLocked: false,
    deliveryCode,
    deliveryAttempts: 0,
    deliveryLocked: false,
    trackingToken,
  });
  await booking.save();
}
