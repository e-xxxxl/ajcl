import { connectToDatabase } from "../db";
import { Booking, type BookingHydrated } from "../../models/Booking";
import { User } from "../../models/User";
import { ApiError } from "../api";
import { changeBookingStatus } from "./booking";
import { ensureHandoverCodes } from "./handover";
import { sendRiderAssignedEmails } from "./booking-emails";
import { notify, notifyAllAdmins } from "../notifications";

const MAX_CODE_ATTEMPTS = 5;

/** Assign (or reassign) a rider account to a booking. Moves confirmed → driver_assigned;
 *  a reassignment before pickup keeps the current status but re-notifies everyone. */
export async function assignRiderToBooking(params: {
  bookingReference: string;
  riderId: string;
  actorId: string;
  note?: string;
}): Promise<BookingHydrated> {
  await connectToDatabase();

  const rider = await User.findOne({ _id: params.riderId, role: "rider" }).lean();
  if (!rider) throw new ApiError("Rider not found.", 404);
  if ((rider as unknown as { rider?: { active?: boolean } }).rider?.active === false) {
    throw new ApiError("This rider account is deactivated.", 409);
  }

  const booking = await Booking.findOne({
    bookingReference: params.bookingReference.toUpperCase(),
  });
  if (!booking) throw new ApiError("Booking not found.", 404);

  if (!["confirmed", "driver_assigned"].includes(booking.status)) {
    throw new ApiError(`Cannot assign a rider to a ${booking.status} booking.`, 409);
  }
  if (booking.status === "driver_assigned" && booking.handover?.pickupCodeUsedAt) {
    throw new ApiError(
      "The package has already been picked up — the rider can no longer be reassigned.",
      409,
    );
  }

  const wasAlreadyAssigned = booking.status === "driver_assigned";

  booking.assignedRider = rider._id as unknown as BookingHydrated["assignedRider"];
  booking.assignedDriver = {
    name: `${rider.firstName} ${rider.lastName}`.trim(),
    phone: rider.phone,
    plate: (rider as unknown as { rider?: { plate?: string } }).rider?.plate,
  };
  await booking.save();

  let updated = booking;
  if (!wasAlreadyAssigned) {
    updated = await changeBookingStatus({
      bookingId: String(booking._id),
      to: "driver_assigned",
      note: params.note || "Rider assigned",
      actorRole: "admin",
      actorId: params.actorId,
    });
  } else {
    // Status didn't change. Still tell the customer (in-app) and both parties (email)
    // who the new rider is.
    await notify.statusChanged(String(booking.user), booking, "driver_assigned", { skipEmail: true });
    await sendRiderAssignedEmails(booking._id);
  }

  await notify.riderJobAssigned(String(rider._id), updated);
  return updated;
}

function normalizeCode(input: string): string {
  return input.replace(/\D/g, "").trim();
}

async function loadRiderJob(bookingReference: string, riderId: string, codeField: "pickupCode" | "deliveryCode") {
  const booking = await Booking.findOne({
    bookingReference: bookingReference.toUpperCase(),
  }).select(`+handover.${codeField}`);
  if (!booking) throw new ApiError("Job not found.", 404);
  if (!booking.assignedRider || String(booking.assignedRider) !== riderId) {
    throw new ApiError("This job is not assigned to you.", 403);
  }
  return booking;
}

/** Rider confirms pickup by scanning/typing the sender's code. */
export async function confirmPickup(params: {
  bookingReference: string;
  riderId: string;
  code: string;
}): Promise<BookingHydrated> {
  await connectToDatabase();
  const booking = await loadRiderJob(params.bookingReference, params.riderId, "pickupCode");

  if (booking.status !== "driver_assigned") {
    if (booking.status === "in_transit" || booking.status === "delivered") {
      throw new ApiError("Pickup has already been confirmed for this booking.", 409);
    }
    throw new ApiError("This booking is not ready for pickup yet.", 409);
  }
  if (booking.handover?.pickupLocked) {
    throw new ApiError(
      "Too many incorrect attempts. Ask an admin to reset the pickup code.",
      423,
    );
  }
  if (!booking.handover?.pickupCode) {
    await ensureHandoverCodes(booking);
  }

  const stored = booking.handover?.pickupCode;
  const submitted = normalizeCode(params.code);
  if (!stored || submitted.length !== 6 || submitted !== stored) {
    await registerWrongAttempt(booking, "pickup");
    throw new ApiError(
      booking.handover?.pickupLocked
        ? "Too many incorrect attempts. This code is now locked — contact an admin."
        : "Incorrect pickup code. Please check with the sender and try again.",
      booking.handover?.pickupLocked ? 423 : 400,
    );
  }

  booking.handover.pickupCodeUsedAt = new Date();
  booking.handover.pickupAttempts = 0;
  await booking.save();

  const updated = await changeBookingStatus({
    bookingId: String(booking._id),
    to: "in_transit",
    note: "Pickup code verified by rider",
    actorRole: "rider",
    actorId: params.riderId,
  });

  await notifyAllAdmins(
    updated,
    "admin_pickup_confirmed",
    `${updated.bookingReference} was picked up — pickup code verified by the rider.`,
  );

  return updated;
}

/** Rider confirms delivery by scanning/typing the receiver's code. */
export async function confirmDelivery(params: {
  bookingReference: string;
  riderId: string;
  code: string;
}): Promise<BookingHydrated> {
  await connectToDatabase();
  const booking = await loadRiderJob(params.bookingReference, params.riderId, "deliveryCode");

  if (booking.status !== "in_transit") {
    if (booking.status === "delivered") {
      throw new ApiError("This booking has already been marked delivered.", 409);
    }
    if (booking.status === "driver_assigned") {
      throw new ApiError("Confirm pickup before confirming delivery.", 409);
    }
    throw new ApiError("This booking is not out for delivery yet.", 409);
  }
  if (booking.handover?.deliveryLocked) {
    throw new ApiError(
      "Too many incorrect attempts. Ask an admin to reset the delivery code.",
      423,
    );
  }
  if (!booking.handover?.deliveryCode) {
    await ensureHandoverCodes(booking);
  }

  const stored = booking.handover?.deliveryCode;
  const submitted = normalizeCode(params.code);
  if (!stored || submitted.length !== 6 || submitted !== stored) {
    await registerWrongAttempt(booking, "delivery");
    throw new ApiError(
      booking.handover?.deliveryLocked
        ? "Too many incorrect attempts. This code is now locked — contact an admin."
        : "Incorrect delivery code. Please check with the receiver and try again.",
      booking.handover?.deliveryLocked ? 423 : 400,
    );
  }

  booking.handover.deliveryCodeUsedAt = new Date();
  booking.handover.deliveryAttempts = 0;
  await booking.save();

  const updated = await changeBookingStatus({
    bookingId: String(booking._id),
    to: "delivered",
    note: "Delivery code verified by rider",
    actorRole: "rider",
    actorId: params.riderId,
  });

  await notifyAllAdmins(
    updated,
    "admin_delivery_confirmed",
    `${updated.bookingReference} was delivered — delivery code verified by the rider.`,
  );

  return updated;
}

async function registerWrongAttempt(booking: BookingHydrated, stage: "pickup" | "delivery") {
  const attemptsField = stage === "pickup" ? "pickupAttempts" : "deliveryAttempts";
  const lockedField = stage === "pickup" ? "pickupLocked" : "deliveryLocked";
  const attempts = (booking.handover?.[attemptsField] ?? 0) + 1;
  booking.handover[attemptsField] = attempts;
  const justLocked = attempts >= MAX_CODE_ATTEMPTS;
  if (justLocked) booking.handover[lockedField] = true;
  await booking.save();

  if (justLocked) {
    await notifyAllAdmins(
      booking,
      "admin_code_locked",
      `The ${stage} code for ${booking.bookingReference} was locked after ${MAX_CODE_ATTEMPTS} incorrect attempts.`,
    );
  }
}

/** Admin: reset a locked code (clears the lock + attempt counter, keeps the same code). */
export async function resetHandoverLock(
  bookingReference: string,
  stage: "pickup" | "delivery",
): Promise<BookingHydrated> {
  await connectToDatabase();
  const booking = await Booking.findOne({ bookingReference: bookingReference.toUpperCase() });
  if (!booking) throw new ApiError("Booking not found.", 404);

  const attemptsField = stage === "pickup" ? "pickupAttempts" : "deliveryAttempts";
  const lockedField = stage === "pickup" ? "pickupLocked" : "deliveryLocked";
  booking.handover[attemptsField] = 0;
  booking.handover[lockedField] = false;
  await booking.save();
  return booking;
}
