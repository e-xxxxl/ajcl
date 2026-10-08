import { Router } from "express";
import { z } from "zod";
import { connectToDatabase } from "../lib/db";
import { ok, asyncHandler, parse, ApiError } from "../lib/api";
import { requireRider } from "../lib/auth/middleware";
import { loginSchema } from "../lib/validation/auth";
import { verifyPassword, hashPassword } from "../lib/auth/password";
import { signSession, SESSION_MAX_AGE_SECONDS, SHORT_SESSION_MAX_AGE_SECONDS } from "../lib/auth/jwt";
import { enforceRateLimit } from "../lib/rate-limit";
import { User } from "../models/User";
import { Booking } from "../models/Booking";
import { serializeBooking } from "../lib/serialize";
import { confirmPickup, confirmDelivery } from "../lib/services/rider";

export const riderRouter = Router();

/** POST /api/rider/login — same credentials flow as admin login, rider-only. */
riderRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    enforceRateLimit(req, "rider-login", { limit: 10, windowMs: 15 * 60 * 1000 });
    const input = parse(loginSchema, req.body);

    await connectToDatabase();
    const user = await User.findOne({ email: input.email }).select("+passwordHash");
    const valid = user ? await verifyPassword(input.password, user.passwordHash) : false;

    if (!user || !valid) throw new ApiError("Incorrect email or password.", 401);
    if (user.role !== "rider") throw new ApiError("This account does not have rider access.", 403);
    const riderInfo = (user as unknown as { rider?: { active?: boolean; plate?: string; vehicleType?: string } }).rider;
    if (riderInfo?.active === false) {
      throw new ApiError("Your rider account has been deactivated. Contact your admin.", 403);
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = await signSession(
      {
        sub: String(user._id),
        role: "rider",
        email: user.email,
        name: `${user.firstName} ${user.lastName}`.trim(),
      },
      input.remember ? SESSION_MAX_AGE_SECONDS : SHORT_SESSION_MAX_AGE_SECONDS,
    );

    return ok(res, {
      token,
      user: {
        id: String(user._id),
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: `${user.firstName} ${user.lastName}`.trim(),
        email: user.email,
        phone: user.phone,
        role: "rider" as const,
        rider: { plate: riderInfo?.plate, vehicleType: riderInfo?.vehicleType, active: true },
      },
    });
  }),
);

const selfPatchSchema = z.object({
  phone: z.string().trim().min(7).max(20).optional(),
  password: z
    .string()
    .min(8, "Use at least 8 characters")
    .max(72)
    .regex(/[a-z]/, "Add a lowercase letter")
    .regex(/[A-Z]/, "Add an uppercase letter")
    .regex(/[0-9]/, "Add a number")
    .optional(),
  currentPassword: z.string().optional(),
});

/** PATCH /api/rider/me — a rider updates their own phone and/or password. */
riderRouter.patch(
  "/me",
  asyncHandler(async (req, res) => {
    const session = requireRider(req);
    await connectToDatabase();
    const input = parse(selfPatchSchema, req.body);

    const rider = await User.findById(session.sub).select("+passwordHash");
    if (!rider) throw new ApiError("Account not found.", 404);

    if (input.password) {
      const ok = input.currentPassword
        ? await verifyPassword(input.currentPassword, rider.passwordHash)
        : false;
      if (!ok) throw new ApiError("Your current password is incorrect.", 401);
      rider.passwordHash = await hashPassword(input.password);
    }
    if (input.phone) rider.phone = input.phone;
    await rider.save();

    const riderInfo = (rider as unknown as { rider?: { active?: boolean; plate?: string; vehicleType?: string } }).rider;
    return ok(res, {
      user: {
        id: String(rider._id),
        firstName: rider.firstName,
        lastName: rider.lastName,
        fullName: `${rider.firstName} ${rider.lastName}`.trim(),
        email: rider.email,
        phone: rider.phone,
        role: "rider" as const,
        rider: { plate: riderInfo?.plate, vehicleType: riderInfo?.vehicleType, active: riderInfo?.active !== false },
      },
    });
  }),
);

/** GET /api/rider/jobs — every booking assigned to the current rider. */
riderRouter.get(
  "/jobs",
  asyncHandler(async (req, res) => {
    const session = requireRider(req);
    await connectToDatabase();

    const bookings = await Booking.find({ assignedRider: session.sub })
      .sort({ scheduledAt: 1 })
      .limit(200)
      .lean();

    return ok(res, { jobs: bookings.map((b) => serializeBooking(b)) });
  }),
);

/** GET /api/rider/jobs/:reference — one job, must belong to this rider. */
riderRouter.get(
  "/jobs/:reference",
  asyncHandler(async (req, res) => {
    const session = requireRider(req);
    await connectToDatabase();

    const booking = await Booking.findOne({
      bookingReference: req.params.reference.toUpperCase(),
    }).lean();
    if (!booking || !booking.assignedRider || String(booking.assignedRider) !== session.sub) {
      throw new ApiError("Job not found.", 404);
    }

    return ok(res, { job: serializeBooking(booking) });
  }),
);

const codeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(4, "Enter the 6-digit code")
    .max(12, "Enter the 6-digit code"),
});

/** POST /api/rider/jobs/:reference/pickup — confirm pickup with the sender's code. */
riderRouter.post(
  "/jobs/:reference/pickup",
  asyncHandler(async (req, res) => {
    const session = requireRider(req);
    enforceRateLimit(req, "rider-pickup", { limit: 30, windowMs: 10 * 60 * 1000 });
    const { code } = parse(codeSchema, req.body);

    const updated = await confirmPickup({
      bookingReference: req.params.reference,
      riderId: session.sub,
      code,
    });

    return ok(res, { job: serializeBooking(updated.toObject()) });
  }),
);

/** POST /api/rider/jobs/:reference/deliver — confirm delivery with the receiver's code. */
riderRouter.post(
  "/jobs/:reference/deliver",
  asyncHandler(async (req, res) => {
    const session = requireRider(req);
    enforceRateLimit(req, "rider-deliver", { limit: 30, windowMs: 10 * 60 * 1000 });
    const { code } = parse(codeSchema, req.body);

    const updated = await confirmDelivery({
      bookingReference: req.params.reference,
      riderId: session.sub,
      code,
    });

    return ok(res, { job: serializeBooking(updated.toObject()) });
  }),
);
