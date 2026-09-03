import { Router } from "express";
import { z } from "zod";
import { connectToDatabase } from "../lib/db";
import { ok, asyncHandler, parse, ApiError } from "../lib/api";
import { requireAdmin, requireSuperAdmin } from "../lib/auth/middleware";
import { loginSchema } from "../lib/validation/auth";
import { verifyPassword, hashPassword } from "../lib/auth/password";
import { signSession, SESSION_MAX_AGE_SECONDS, SHORT_SESSION_MAX_AGE_SECONDS } from "../lib/auth/jwt";
import { enforceRateLimit } from "../lib/rate-limit";
import { ensureBootstrapped } from "../lib/bootstrap";
import { User } from "../models/User";
import { Booking } from "../models/Booking";
import { StatusHistory } from "../models/StatusHistory";
import { Payment } from "../models/Payment";
import { Vehicle } from "../models/Vehicle";
import { Notification } from "../models/Notification";
import { serializeBooking, serializeVehicle } from "../lib/serialize";
import { getAdminStats, listBookingsForAdmin } from "../lib/services/admin";
import { changeBookingStatus } from "../lib/services/booking";
import { activeUnitsBySlug } from "../lib/services/fleet";
import { vehicleUpsertSchema, vehiclePatchSchema } from "../lib/validation/vehicle";
import { slugify } from "../lib/utils";
import { BOOKING_STATUS_FLOW } from "../config/booking";

export const adminRouter = Router();

/** POST /api/admin/login — identical flow to /auth/login but rejects non-admins. */
adminRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    enforceRateLimit(req, "admin-login", { limit: 8, windowMs: 15 * 60 * 1000 });
    const input = parse(loginSchema, req.body);

    await connectToDatabase();
    await ensureBootstrapped();

    const user = await User.findOne({ email: input.email }).select("+passwordHash");
    const valid = user ? await verifyPassword(input.password, user.passwordHash) : false;

    if (!user || !valid) throw new ApiError("Incorrect email or password.", 401);
    if (user.role !== "admin") throw new ApiError("This account does not have admin access.", 403);

    user.lastLoginAt = new Date();
    await user.save();

    const superAdmin = Boolean(user.superAdmin);
    const token = await signSession(
      {
        sub: String(user._id),
        role: "admin",
        email: user.email,
        name: `${user.firstName} ${user.lastName}`.trim(),
        superAdmin,
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
        role: "admin" as const,
        superAdmin,
      },
    });
  }),
);

/** GET /api/admin/stats */
adminRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    await connectToDatabase();

    const [stats, recent] = await Promise.all([
      getAdminStats(),
      Booking.find({})
        .sort({ createdAt: -1 })
        .limit(8)
        .populate("user", "firstName lastName email phone")
        .lean(),
    ]);

    return ok(res, {
      stats,
      recent: recent.map((b) => serializeBooking(b, { includeCustomer: true })),
    });
  }),
);

/** GET /api/admin/bookings */
adminRouter.get(
  "/bookings",
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const q = req.query as Record<string, string | undefined>;

    const result = await listBookingsForAdmin({
      status: q.status,
      paymentStatus: q.payment,
      search: q.search,
      from: q.from,
      to: q.to,
      page: Number(q.page) || 1,
      pageSize: Number(q.pageSize) || 20,
    });

    return ok(res, {
      bookings: result.items.map((b) => serializeBooking(b, { includeCustomer: true })),
      pagination: {
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        pages: result.pages,
      },
    });
  }),
);

/** GET /api/admin/bookings/:reference — full detail + audit + payment ledger. */
adminRouter.get(
  "/bookings/:reference",
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    await connectToDatabase();

    const booking = await Booking.findOne({
      bookingReference: req.params.reference.toUpperCase(),
    })
      .populate("user", "firstName lastName email phone createdAt")
      .lean();
    if (!booking) throw new ApiError("Booking not found.", 404);

    const [audit, payments] = await Promise.all([
      StatusHistory.find({ booking: booking._id }).sort({ at: -1 }).lean(),
      Payment.find({ booking: booking._id }).sort({ createdAt: -1 }).lean(),
    ]);

    return ok(res, {
      booking: serializeBooking(booking, { includeCustomer: true }),
      audit: audit.map((a) => ({
        id: String(a._id),
        fromStatus: a.fromStatus ?? null,
        toStatus: a.toStatus,
        note: a.note ?? null,
        actorRole: a.actorRole,
        actorName: a.actorName ?? null,
        at: new Date(a.at).toISOString(),
      })),
      payments: payments.map((p) => ({
        id: String(p._id),
        reference: p.reference,
        status: p.status,
        amount: p.amount,
        currency: p.currency,
        channel: p.channel ?? null,
        verifiedVia: p.verifiedVia,
        paidAt: p.paidAt ? new Date(p.paidAt).toISOString() : null,
        gatewayResponse: p.gatewayResponse ?? null,
        createdAt: new Date(p.createdAt as unknown as string).toISOString(),
      })),
    });
  }),
);

const STATUSES = [...BOOKING_STATUS_FLOW, "cancelled"] as const;
const statusSchema = z.object({
  status: z.enum(STATUSES),
  note: z.string().trim().max(500).optional(),
  driverName: z.string().trim().max(120).optional(),
  driverPhone: z.string().trim().max(30).optional(),
  driverPlate: z.string().trim().max(20).optional(),
  force: z.boolean().optional(),
});

/** PATCH /api/admin/bookings/:reference/status */
adminRouter.patch(
  "/bookings/:reference/status",
  asyncHandler(async (req, res) => {
    const admin = requireAdmin(req);
    await connectToDatabase();

    const input = parse(statusSchema, req.body);
    const booking = await Booking.findOne({
      bookingReference: req.params.reference.toUpperCase(),
    });
    if (!booking) throw new ApiError("Booking not found.", 404);

    const updated = await changeBookingStatus({
      bookingId: String(booking._id),
      to: input.status,
      note: input.note,
      actorRole: "admin",
      actorId: admin.sub,
      driver:
        input.driverName || input.driverPhone || input.driverPlate
          ? { name: input.driverName, phone: input.driverPhone, plate: input.driverPlate }
          : undefined,
      force: input.force,
    });

    return ok(res, { booking: serializeBooking(updated.toObject(), { includeCustomer: false }) });
  }),
);

const riderSchema = z.object({
  name: z.string().trim().max(120).optional().default(""),
  phone: z.string().trim().max(30).optional().default(""),
  plate: z.string().trim().max(20).optional().default(""),
});

/** PATCH /api/admin/bookings/:reference/rider — set/update the assigned rider
 *  (name, phone, plate) without changing the booking status. */
adminRouter.patch(
  "/bookings/:reference/rider",
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    await connectToDatabase();

    const input = parse(riderSchema, req.body);
    const booking = await Booking.findOne({
      bookingReference: req.params.reference.toUpperCase(),
    });
    if (!booking) throw new ApiError("Booking not found.", 404);
    if (["delivered", "cancelled"].includes(booking.status)) {
      throw new ApiError("This booking is closed — rider details can't be changed.", 409);
    }

    booking.assignedDriver = {
      name: input.name || undefined,
      phone: input.phone || undefined,
      plate: input.plate ? input.plate.toUpperCase() : undefined,
    };
    await booking.save();

    return ok(res, { booking: serializeBooking(booking.toObject(), { includeCustomer: false }) });
  }),
);

/* ── Super-admin: delete bookings ──────────────────────────────────────── */

/** Remove a booking and everything that hangs off it. */
async function hardDeleteBookings(filter: Record<string, unknown>): Promise<number> {
  const bookings = await Booking.find(filter).select("_id").lean();
  const ids = bookings.map((b) => b._id);
  if (ids.length === 0) return 0;
  await Promise.all([
    Payment.deleteMany({ booking: { $in: ids } }),
    StatusHistory.deleteMany({ booking: { $in: ids } }),
    Notification.deleteMany({ booking: { $in: ids } }),
    Booking.deleteMany({ _id: { $in: ids } }),
  ]);
  return ids.length;
}

/** DELETE /api/admin/bookings/:reference — permanently delete one booking. */
adminRouter.delete(
  "/bookings/:reference",
  asyncHandler(async (req, res) => {
    requireSuperAdmin(req);
    await connectToDatabase();
    const deleted = await hardDeleteBookings({
      bookingReference: req.params.reference.toUpperCase(),
    });
    if (deleted === 0) throw new ApiError("Booking not found.", 404);
    return ok(res, { deleted });
  }),
);

const purgeSchema = z.object({
  /** "all" wipes every booking; "cancelled"/"delivered" only that status. */
  scope: z.enum(["all", "cancelled", "delivered"]),
  /** Must equal "DELETE" — a deliberate-action guard. */
  confirm: z.literal("DELETE"),
});

/** POST /api/admin/bookings/purge — bulk-delete bookings (test-data cleanup). */
adminRouter.post(
  "/bookings/purge",
  asyncHandler(async (req, res) => {
    requireSuperAdmin(req);
    await connectToDatabase();
    const { scope } = parse(purgeSchema, req.body);
    const filter = scope === "all" ? {} : { status: scope };
    const deleted = await hardDeleteBookings(filter);
    return ok(res, { deleted, scope });
  }),
);

/* ── Super-admin: manage admin accounts ────────────────────────────────── */

const createAdminSchema = z.object({
  firstName: z.string().trim().min(1, "Required").max(60),
  lastName: z.string().trim().min(1, "Required").max(60),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  phone: z.string().trim().min(7).max(30).optional().default(""),
  password: z
    .string()
    .min(8, "Use at least 8 characters")
    .max(72)
    .regex(/[a-z]/, "Add a lowercase letter")
    .regex(/[A-Z]/, "Add an uppercase letter")
    .regex(/[0-9]/, "Add a number"),
  superAdmin: z.boolean().optional().default(false),
});

function serializeAdmin(u: {
  _id: unknown;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  superAdmin?: boolean;
  lastLoginAt?: Date | null;
  createdAt?: Date | string;
}) {
  return {
    id: String(u._id),
    firstName: u.firstName,
    lastName: u.lastName,
    fullName: `${u.firstName} ${u.lastName}`.trim(),
    email: u.email,
    phone: u.phone,
    superAdmin: Boolean(u.superAdmin),
    lastLoginAt: u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : null,
    createdAt: u.createdAt ? new Date(u.createdAt as string).toISOString() : null,
  };
}

/** GET /api/admin/admins — list admin accounts. */
adminRouter.get(
  "/admins",
  asyncHandler(async (req, res) => {
    requireSuperAdmin(req);
    await connectToDatabase();
    const admins = await User.find({ role: "admin" }).sort({ createdAt: 1 }).lean();
    return ok(res, { admins: admins.map(serializeAdmin) });
  }),
);

/** POST /api/admin/admins — create a new admin account. */
adminRouter.post(
  "/admins",
  asyncHandler(async (req, res) => {
    const me = requireSuperAdmin(req);
    await connectToDatabase();
    const input = parse(createAdminSchema, req.body);

    if (await User.exists({ email: input.email })) {
      throw new ApiError("An account with that email already exists.", 409);
    }

    const admin = await User.create({
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone || "0000000000",
      passwordHash: await hashPassword(input.password),
      role: "admin",
      superAdmin: input.superAdmin,
    });
    console.info(`[admin] ${me.email} created admin ${input.email}`);

    return ok(res, { admin: serializeAdmin(admin.toObject()) }, 201);
  }),
);

/** DELETE /api/admin/admins/:id — remove an admin account (not yourself). */
adminRouter.delete(
  "/admins/:id",
  asyncHandler(async (req, res) => {
    const me = requireSuperAdmin(req);
    await connectToDatabase();

    if (req.params.id === me.sub) {
      throw new ApiError("You can't remove your own admin account.", 400);
    }
    const target = await User.findById(req.params.id);
    if (!target || target.role !== "admin") throw new ApiError("Admin not found.", 404);

    await User.deleteOne({ _id: target._id });
    console.info(`[admin] ${me.email} removed admin ${target.email}`);
    return ok(res, { deleted: true });
  }),
);

/** GET /api/admin/vehicles — all vehicles (incl. inactive) + live fleet usage. */
adminRouter.get(
  "/vehicles",
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    await connectToDatabase();
    const [vehicles, inUse] = await Promise.all([
      Vehicle.find({}).sort({ sortOrder: 1, name: 1 }).lean(),
      activeUnitsBySlug(),
    ]);
    return ok(res, {
      vehicles: vehicles.map((v) => ({
        ...serializeVehicle(v),
        unitsInUse: inUse.get(v.slug) ?? 0,
      })),
    });
  }),
);

/** POST /api/admin/vehicles — create a vehicle. */
adminRouter.post(
  "/vehicles",
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    await connectToDatabase();

    const input = parse(vehicleUpsertSchema, req.body);
    const slug = input.slug || slugify(input.name);
    if (await Vehicle.exists({ slug })) {
      throw new ApiError("A vehicle with that name/slug already exists.", 409);
    }

    const vehicle = await Vehicle.create({ ...input, slug });
    return ok(res, { vehicle: serializeVehicle(vehicle.toObject()) }, 201);
  }),
);

/** PATCH /api/admin/vehicles/:id */
adminRouter.patch(
  "/vehicles/:id",
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    await connectToDatabase();

    const input = parse(vehiclePatchSchema, req.body);
    const vehicle = await Vehicle.findById(req.params.id);
    if (!vehicle) throw new ApiError("Vehicle not found.", 404);

    if (input.slug && input.slug !== vehicle.slug) {
      if (await Vehicle.exists({ slug: input.slug })) {
        throw new ApiError("Another vehicle already uses that slug.", 409);
      }
    }

    Object.assign(vehicle, input);
    await vehicle.save();

    return ok(res, { vehicle: serializeVehicle(vehicle.toObject()) });
  }),
);

/** DELETE /api/admin/vehicles/:id — soft-delete if bookings reference it. */
adminRouter.delete(
  "/vehicles/:id",
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    await connectToDatabase();

    const inUse = await Booking.exists({ "vehicle.vehicleId": req.params.id });
    if (inUse) {
      await Vehicle.findByIdAndUpdate(req.params.id, { active: false });
      return ok(res, { deactivated: true });
    }
    await Vehicle.findByIdAndDelete(req.params.id);
    return ok(res, { deleted: true });
  }),
);
