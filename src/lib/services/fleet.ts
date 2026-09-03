import { Booking } from "../../models/Booking";

/**
 * Booking statuses that occupy a vehicle unit. A `pending` (unpaid) booking
 * does NOT hold a unit; `delivered` / `cancelled` release it.
 */
export const OCCUPYING_STATUSES = ["confirmed", "driver_assigned", "in_transit"] as const;

/** Map of vehicle slug → units currently on active deliveries. */
export async function activeUnitsBySlug(): Promise<Map<string, number>> {
  const rows = await Booking.aggregate<{ _id: string; count: number }>([
    { $match: { status: { $in: OCCUPYING_STATUSES as unknown as string[] } } },
    { $group: { _id: "$vehicle.slug", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id ?? "", r.count]));
}

/** Units still free for a class. `null` = unlimited (no fleet cap set). */
export function unitsAvailable(fleetSize: number | undefined, inUse: number): number | null {
  if (!fleetSize || fleetSize <= 0) return null;
  return Math.max(0, fleetSize - inUse);
}

/** Is every unit of this class already on an active delivery? */
export async function isClassSoldOut(
  slug: string,
  fleetSize: number | undefined,
  opts: { excludeBookingId?: string } = {},
): Promise<boolean> {
  if (!fleetSize || fleetSize <= 0) return false;
  const query: Record<string, unknown> = {
    "vehicle.slug": slug,
    status: { $in: OCCUPYING_STATUSES as unknown as string[] },
  };
  if (opts.excludeBookingId) query._id = { $ne: opts.excludeBookingId };
  const inUse = await Booking.countDocuments(query);
  return inUse >= fleetSize;
}
