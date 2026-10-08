import { connectToDatabase } from "../db";
import { env } from "../env";
import { Booking, type BookingHydrated } from "../../models/Booking";
import { User } from "../../models/User";
import { changeBookingStatus } from "./booking";
import { notify } from "../notifications";

/**
 * Automatic rider allocation.
 *
 * A rider is eligible when their account is active, their vehicle type fits the
 * booking's vehicle (a rider with no vehicle type set takes any), and they hold
 * fewer than `RIDER_MAX_ACTIVE_JOBS` active jobs. Among eligible riders the one
 * with the fewest active jobs wins; ties go to whoever was assigned least recently,
 * so work rotates evenly. When nobody is eligible the booking stays "confirmed" and
 * is picked up later by `autoAssignPending` (a rider frees up or is added), or
 * assigned by hand from the admin dashboard.
 */

type RiderLean = {
  _id: unknown;
  firstName: string;
  lastName: string;
  phone: string;
  rider?: { plate?: string | null; vehicleType?: string | null; active?: boolean | null };
};

const ACTIVE = ["driver_assigned", "in_transit"];

const norm = (s?: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const ALIASES: Record<string, string[]> = {
  bike: ["motorcycle", "motorbike", "okada"],
};

/** Does a rider's vehicle type fit this booking's vehicle? Empty = any vehicle. */
export function riderFitsVehicle(
  riderType: string | null | undefined,
  vehicle: { slug?: string | null; name?: string | null },
): boolean {
  const rt = norm(riderType);
  if (!rt) return true;
  const targets = [norm(vehicle.slug), norm(vehicle.name)].filter(Boolean);
  const all = [...targets, ...targets.flatMap((t) => ALIASES[t] ?? [])];
  return all.some((t) => rt === t || rt.includes(t) || t.includes(rt));
}

/** The best eligible rider for this booking, or null when nobody is free. */
export async function findBestRider(
  booking: { vehicle?: { slug?: string | null; name?: string | null } | null },
  opts: { excludeRiderId?: string } = {},
): Promise<RiderLean | null> {
  await connectToDatabase();

  const riders = (await User.find({ role: "rider", "rider.active": { $ne: false } }).lean()) as unknown as RiderLean[];
  const fitting = riders.filter(
    (r) =>
      String(r._id) !== opts.excludeRiderId &&
      riderFitsVehicle(r.rider?.vehicleType, booking.vehicle ?? {}),
  );
  if (fitting.length === 0) return null;

  const stats = await Booking.aggregate<{ _id: unknown; active: number; last?: Date }>([
    { $match: { assignedRider: { $in: fitting.map((r) => r._id) } } },
    {
      $group: {
        _id: "$assignedRider",
        active: { $sum: { $cond: [{ $in: ["$status", ACTIVE] }, 1, 0] } },
        last: { $max: "$riderAssignedAt" },
      },
    },
  ]);
  const byRider = new Map(stats.map((s) => [String(s._id), s]));

  const candidates = fitting
    .map((r) => {
      const s = byRider.get(String(r._id));
      return { rider: r, active: s?.active ?? 0, last: s?.last ? new Date(s.last).getTime() : 0 };
    })
    .filter((c) => c.active < env.riderMaxActiveJobs)
    .sort(
      (a, b) =>
        a.active - b.active ||
        a.last - b.last ||
        a.rider.firstName.localeCompare(b.rider.firstName),
    );

  return candidates[0]?.rider ?? null;
}

/**
 * Assign the best rider to a paid, confirmed booking. Safe to call from several
 * places at once: the booking is claimed atomically, so it can only be assigned
 * once. Returns the updated booking, or null when nothing was assigned.
 * Never throws.
 */
export async function autoAssignBooking(bookingId: string): Promise<BookingHydrated | null> {
  if (!env.autoAssignRiders) return null;
  try {
    await connectToDatabase();
    const booking = await Booking.findById(bookingId).lean();
    if (!booking || booking.status !== "confirmed" || booking.payment?.status !== "paid") return null;
    if (booking.assignedRider) return null;
    // A rider typed in by hand (no account) is the admin's choice. Leave it.
    if (booking.assignedDriver?.name || booking.assignedDriver?.phone) return null;

    const rider = await findBestRider(booking);
    if (!rider) return null;

    // Claim the booking. Only one concurrent caller can win this update.
    const claim = await Booking.updateOne(
      { _id: booking._id, status: "confirmed", assignedRider: { $exists: false } },
      {
        $set: {
          assignedRider: rider._id,
          riderAssignedAt: new Date(),
          assignedDriver: {
            name: `${rider.firstName} ${rider.lastName}`.trim(),
            phone: rider.phone,
            plate: rider.rider?.plate ?? undefined,
          },
        },
      },
    );
    if (claim.modifiedCount === 0) return null;

    try {
      const updated = await changeBookingStatus({
        bookingId: String(booking._id),
        to: "driver_assigned",
        note: "Rider assigned automatically",
        actorRole: "system",
      });
      await notify.riderJobAssigned(String(rider._id), updated);
      return updated;
    } catch (err) {
      // Release the claim so the next sweep (or an admin) can try again.
      await Booking.updateOne(
        { _id: booking._id, status: "confirmed" },
        { $unset: { assignedRider: "", assignedDriver: "", riderAssignedAt: "" } },
      );
      throw err;
    }
  } catch (err) {
    console.error("[autoassign] failed for", bookingId, err instanceof Error ? err.message : err);
    return null;
  }
}

let sweeping = false;

/**
 * Try to place every paid booking still waiting for a rider, oldest pickup first.
 * Runs when a rider finishes a delivery or a rider is added/re-activated. Bookings
 * whose pickup time is long past are skipped, so an old stranded booking is never
 * auto-assigned (and the customer never emailed) out of the blue. Never throws.
 */
export async function autoAssignPending(): Promise<number> {
  if (!env.autoAssignRiders || sweeping) return 0;
  sweeping = true;
  let assigned = 0;
  try {
    await connectToDatabase();
    const waiting = await Booking.find({
      status: "confirmed",
      "payment.status": "paid",
      assignedRider: { $exists: false },
      "assignedDriver.name": { $exists: false },
      scheduledAt: { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) },
    })
      .sort({ scheduledAt: 1 })
      .limit(50)
      .select("_id")
      .lean();

    for (const b of waiting) {
      if (await autoAssignBooking(String(b._id))) assigned += 1;
    }
    if (assigned > 0) console.info(`[autoassign] placed ${assigned} waiting booking(s)`);
  } catch (err) {
    console.error("[autoassign] sweep failed", err instanceof Error ? err.message : err);
  } finally {
    sweeping = false;
  }
  return assigned;
}
