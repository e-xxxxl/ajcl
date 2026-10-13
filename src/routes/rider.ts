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
import { serializeRiderJob } from "../lib/serialize";
import { verifyHandoverCode, confirmHandover } from "../lib/services/rider";
import {
  riderAcceptBooking,
  riderFitsVehicle,
  riderLimit,
  isOpenForAssignment,
} from "../lib/services/autoassign";
import { planRoute, detourFor, pointOf, haversineKm, ROAD_FACTOR, type PlannerJob } from "../lib/services/route-plan";
import { env } from "../lib/env";
import type { RiderRouteDTO } from "../types";

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

    return ok(res, { jobs: bookings.map((b) => serializeRiderJob(b)) });
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

    return ok(res, { job: serializeRiderJob(booking) });
  }),
);

const codeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(4, "Enter the 6-digit code")
    .max(12, "Enter the 6-digit code"),
});

const photoSchema = z.string().min(100).max(1_200_000);

const locationSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  accuracyM: z.number().min(0).max(100_000).optional(),
  /** Age of the GPS fix in ms, measured on the device. */
  ageMs: z.number().min(0).max(24 * 3600 * 1000),
});

const confirmSchema = z.object({
  proofToken: z.string().min(20).max(2000),
  photos: z.array(photoSchema).min(1, "Take a photo as proof").max(2),
  location: locationSchema,
});

/** POST /api/rider/jobs/:reference/pickup/verify and /deliver/verify
 *  Step 1: check the sender's / receiver's code. Returns a short-lived token for step 2. */
for (const stage of ["pickup", "delivery"] as const) {
  const path = stage === "pickup" ? "pickup" : "deliver";

  riderRouter.post(
    `/jobs/:reference/${path}/verify`,
    asyncHandler(async (req, res) => {
      const session = requireRider(req);
      enforceRateLimit(req, `rider-${path}-verify`, { limit: 30, windowMs: 10 * 60 * 1000 });
      const { code } = parse(codeSchema, req.body);

      const result = await verifyHandoverCode({
        bookingReference: req.params.reference,
        riderId: session.sub,
        stage,
        code,
      });
      return ok(res, result);
    }),
  );

  /** POST /api/rider/jobs/:reference/pickup and /deliver
   *  Step 2: submit the proof token, a photo and the GPS fix. Confirms the handover. */
  riderRouter.post(
    `/jobs/:reference/${path}`,
    asyncHandler(async (req, res) => {
      const session = requireRider(req);
      enforceRateLimit(req, `rider-${path}`, { limit: 20, windowMs: 10 * 60 * 1000 });
      const input = parse(confirmSchema, req.body);

      const updated = await confirmHandover({
        bookingReference: req.params.reference,
        riderId: session.sub,
        stage,
        proofToken: input.proofToken,
        photos: input.photos,
        location: input.location,
      });
      return ok(res, { job: serializeRiderJob(updated.toObject()) });
    }),
  );
}

/** GET /api/rider/route?lat=&lng= : the rider's active jobs in one efficient order,
 *  plus open orders that fit that route (and can be accepted). Location is optional. */
riderRouter.get(
  "/route",
  asyncHandler(async (req, res) => {
    const session = requireRider(req);
    await connectToDatabase();

    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const origin =
      Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
        ? { lat, lng }
        : null;

    const [riderDoc, jobs] = await Promise.all([
      User.findById(session.sub).lean(),
      Booking.find({
        assignedRider: session.sub,
        status: { $in: ["driver_assigned", "in_transit"] },
      }).lean(),
    ]);
    if (!riderDoc) throw new ApiError("Account not found.", 404);
    const rider = riderDoc as unknown as Parameters<typeof riderLimit>[0] & {
      rider?: { vehicleType?: string | null };
    };

    const plan = planRoute(jobs as unknown as PlannerJob[], origin);
    const maxActive = riderLimit(rider);
    const activeCount = jobs.length;

    // Points the rider will pass through, in order (their position first, if known).
    const path = [origin, ...plan.stops.map((st) => pointOf(st.location))].filter(
      (p): p is { lat: number; lng: number } => p !== null,
    );

    const nearby: RiderRouteDTO["nearby"] = [];
    if (path.length > 0) {
      const open = await Booking.find({
        status: "confirmed",
        "payment.status": { $in: ["paid", "on_account"] },
        assignedRider: { $exists: false },
        "assignedDriver.name": { $exists: false },
        scheduledAt: { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) },
      })
        .sort({ scheduledAt: 1 })
        .limit(100)
        .lean();

      const onRoute = plan.stops.length > 0;
      for (const b of open) {
        if (!isOpenForAssignment(b)) continue;
        if (!riderFitsVehicle(rider.rider?.vehicleType, b.vehicle ?? {})) continue;
        const p = pointOf(b.pickup);
        const d = pointOf(b.destination);
        if (!p || !d) continue;

        // Already carrying jobs: how much would this add to the route? Nothing on the
        // go yet: how far is the pickup from where the rider is?
        const extra = onRoute
          ? detourFor(path, p, d)
          : origin
            ? Math.round(haversineKm(origin, p) * ROAD_FACTOR * 10) / 10
            : null;
        if (extra === null || extra > env.routeDetourKm) continue;
        nearby.push({
          job: serializeRiderJob(b),
          extraKm: extra,
          mode: onRoute ? "on_route" : "near_you",
        });
      }
      nearby.sort((a, b) => a.extraKm - b.extraKm);
      nearby.splice(10);
    }

    const payload: RiderRouteDTO = {
      route: {
        stops: plan.stops.map((st) => ({
          ...st,
          location: {
            formattedAddress: st.location.formattedAddress,
            details: st.location.details ?? undefined,
            name: st.location.name ?? undefined,
            area: st.location.area ?? undefined,
            city: st.location.city ?? undefined,
            state: st.location.state ?? undefined,
            lat: st.location.lat ?? undefined,
            lng: st.location.lng ?? undefined,
          },
        })),
        totalKm: plan.totalKm,
        mapsUrl: plan.mapsUrl,
      },
      nearby,
      needsLocation: path.length === 0,
      usedLocation: Boolean(origin),
      activeCount,
      maxActive,
      canAccept: activeCount < maxActive,
      maxDetourKm: env.routeDetourKm,
    };
    return ok(res, payload);
  }),
);

/** POST /api/rider/jobs/:reference/accept : take an open order for yourself. */
riderRouter.post(
  "/jobs/:reference/accept",
  asyncHandler(async (req, res) => {
    const session = requireRider(req);
    enforceRateLimit(req, "rider-accept", { limit: 20, windowMs: 10 * 60 * 1000 });
    const updated = await riderAcceptBooking(session.sub, req.params.reference);
    return ok(res, { job: serializeRiderJob(updated.toObject()) });
  }),
);
