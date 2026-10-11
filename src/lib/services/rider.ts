import { connectToDatabase } from "../db";
import { Booking, type BookingHydrated } from "../../models/Booking";
import { User } from "../../models/User";
import { ApiError } from "../api";
import { changeBookingStatus } from "./booking";
import { ensureHandoverCodes } from "./handover";
import { sendRiderAssignedEmails } from "./booking-emails";
import { autoAssignPending } from "./autoassign";
import { signProofToken, verifyProofToken, PROOF_TOKEN_TTL_SECONDS } from "../auth/jwt";
import {
  MAX_PROOF_PHOTOS,
  parsePhoto,
  checkLocation,
  assessLocation,
  saveProof,
  deleteProof,
  type LocationInput,
} from "./proof";
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
  booking.riderAssignedAt = new Date();
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

type Stage = "pickup" | "delivery";

const STAGE = {
  pickup: {
    codeField: "pickupCode" as const,
    usedField: "pickupCodeUsedAt" as const,
    lockedField: "pickupLocked" as const,
    attemptsField: "pickupAttempts" as const,
    from: "driver_assigned" as const,
    to: "in_transit" as const,
    note: "Pickup verified by rider (code, photo and location)",
    word: "pickup",
    owner: "sender",
  },
  delivery: {
    codeField: "deliveryCode" as const,
    usedField: "deliveryCodeUsedAt" as const,
    lockedField: "deliveryLocked" as const,
    attemptsField: "deliveryAttempts" as const,
    from: "in_transit" as const,
    to: "delivered" as const,
    note: "Delivery verified by rider (code, photo and location)",
    word: "delivery",
    owner: "receiver",
  },
};

/** Step 1. The rider scans or types the code. If it is right they get a short-lived
 *  token that unlocks step 2 (photo + location). The code is NOT consumed yet. */
export async function verifyHandoverCode(params: {
  bookingReference: string;
  riderId: string;
  stage: Stage;
  code: string;
}): Promise<{ proofToken: string; expiresInSeconds: number }> {
  await connectToDatabase();
  const cfg = STAGE[params.stage];
  const booking = await loadRiderJob(params.bookingReference, params.riderId, cfg.codeField);

  if (booking.status !== cfg.from) {
    if (params.stage === "pickup") {
      if (booking.status === "in_transit" || booking.status === "delivered") {
        throw new ApiError("Pickup has already been confirmed for this booking.", 409);
      }
      throw new ApiError("This booking is not ready for pickup yet.", 409);
    }
    if (booking.status === "delivered") throw new ApiError("This booking has already been marked delivered.", 409);
    if (booking.status === "driver_assigned") throw new ApiError("Confirm pickup before confirming delivery.", 409);
    throw new ApiError("This booking is not out for delivery yet.", 409);
  }
  if (booking.handover?.[cfg.lockedField]) {
    throw new ApiError(`Too many incorrect attempts. Ask an admin to reset the ${cfg.word} code.`, 423);
  }
  if (!booking.handover?.[cfg.codeField]) {
    await ensureHandoverCodes(booking);
  }

  const stored = booking.handover?.[cfg.codeField];
  const submitted = normalizeCode(params.code);
  if (!stored || submitted.length !== 6 || submitted !== stored) {
    await registerWrongAttempt(booking, params.stage);
    const locked = booking.handover?.[cfg.lockedField];
    throw new ApiError(
      locked
        ? "Too many incorrect attempts. This code is now locked, contact an admin."
        : `Incorrect ${cfg.word} code. Please check with the ${cfg.owner} and try again.`,
      locked ? 423 : 400,
    );
  }

  booking.handover[cfg.attemptsField] = 0;
  await booking.save();

  const proofToken = await signProofToken({
    sub: params.riderId,
    ref: booking.bookingReference,
    stage: params.stage,
  });
  return { proofToken, expiresInSeconds: PROOF_TOKEN_TTL_SECONDS };
}

/** Step 2. The rider submits the proof token, a photo and their GPS fix. Only now is the
 *  code consumed and the booking moved on. All admins are told, with a flag if the rider
 *  was not near the booked address. */
export async function confirmHandover(params: {
  bookingReference: string;
  riderId: string;
  stage: Stage;
  proofToken: string;
  photos: string[];
  location: LocationInput;
}): Promise<BookingHydrated> {
  await connectToDatabase();
  const cfg = STAGE[params.stage];

  const claims = await verifyProofToken(params.proofToken);
  if (
    !claims ||
    claims.sub !== params.riderId ||
    claims.stage !== params.stage ||
    claims.ref !== params.bookingReference.toUpperCase()
  ) {
    throw new ApiError("Your code check has expired. Enter the code again.", 403);
  }

  // Validate the evidence before touching the booking.
  if (params.photos.length < 1) throw new ApiError("Take a photo as proof before confirming.", 422);
  if (params.photos.length > MAX_PROOF_PHOTOS) {
    throw new ApiError(`You can attach at most ${MAX_PROOF_PHOTOS} photos.`, 422);
  }
  const photos = params.photos.map(parsePhoto);
  const fix = checkLocation(params.location);

  const booking = await Booking.findOne({ bookingReference: params.bookingReference.toUpperCase() });
  if (!booking) throw new ApiError("Job not found.", 404);
  if (!booking.assignedRider || String(booking.assignedRider) !== params.riderId) {
    throw new ApiError("This job is not assigned to you.", 403);
  }
  if (booking.status !== cfg.from || booking.handover?.[cfg.usedField]) {
    throw new ApiError(`The ${cfg.word} for this booking has already been confirmed.`, 409);
  }

  const rider = await User.findById(params.riderId).select("firstName lastName").lean();
  const riderName = rider ? `${rider.firstName} ${rider.lastName}`.trim() : "The rider";
  const target = params.stage === "pickup" ? booking.pickup : booking.destination;
  const assessment = assessLocation(fix, target);

  // Claim this step atomically so a double tap cannot confirm (or store evidence) twice.
  const claim = await Booking.updateOne(
    { _id: String(booking._id), status: cfg.from, [`handover.${cfg.usedField}`]: { $exists: false } },
    { $set: { [`handover.${cfg.usedField}`]: new Date(), [`handover.${cfg.attemptsField}`]: 0 } },
  );
  if (claim.modifiedCount === 0) {
    throw new ApiError(`The ${cfg.word} for this booking has already been confirmed.`, 409);
  }

  let proofId: unknown;
  try {
    const proof = await saveProof({
      bookingId: booking._id,
      bookingReference: booking.bookingReference,
      stage: params.stage,
      riderId: params.riderId,
      riderName,
      photos,
      fix,
      assessment,
    });
    proofId = proof._id;

    const updated = await changeBookingStatus({
      bookingId: String(booking._id),
      to: cfg.to,
      note: cfg.note,
      actorRole: "rider",
      actorId: params.riderId,
    });

    await alertAdminsOfHandover(updated, params.stage, riderName, assessment);
    if (params.stage === "delivery") void autoAssignPending(); // this rider just freed up
    return updated;
  } catch (err) {
    // Roll back so the rider can try again with the same code check.
    if (proofId) await deleteProof(proofId);
    await Booking.updateOne(
      { _id: String(booking._id), status: cfg.from },
      { $unset: { [`handover.${cfg.usedField}`]: "" } },
    );
    throw err;
  }
}

async function alertAdminsOfHandover(
  booking: BookingHydrated,
  stage: Stage,
  riderName: string,
  a: { distanceFromTargetM?: number; flagged: boolean },
) {
  const what = stage === "pickup" ? "picked up" : "delivered";
  const where = stage === "pickup" ? "pickup" : "delivery";
  const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);

  if (a.flagged && a.distanceFromTargetM !== undefined) {
    await notifyAllAdmins(
      booking,
      "admin_handover_flagged",
      `Check ${booking.bookingReference}: ${riderName} confirmed the ${where} about ${km(a.distanceFromTargetM)} from the booked address. Open the booking to review the photo and GPS location.`,
    );
    return;
  }
  await notifyAllAdmins(
    booking,
    stage === "pickup" ? "admin_pickup_confirmed" : "admin_delivery_confirmed",
    `${booking.bookingReference} was ${what} by ${riderName}. Code verified, photo and GPS location recorded${
      a.distanceFromTargetM !== undefined ? ` (${km(a.distanceFromTargetM)} from the ${where} address)` : ""
    }.`,
  );
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
