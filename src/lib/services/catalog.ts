import { connectToDatabase } from "../db";
import { ensureBootstrapped } from "../bootstrap";
import { Vehicle } from "../../models/Vehicle";
import { serializeVehicle } from "../serialize";
import { VEHICLE_SEEDS } from "../../config/pricing";
import { isDatabaseConfigured } from "../env";
import type { VehicleDTO } from "../../types";

/** Active vehicles for public pages. Falls back to seed data if the DB is offline. */
export async function getActiveVehicles(): Promise<{ vehicles: VehicleDTO[]; live: boolean }> {
  if (!isDatabaseConfigured) return { vehicles: seedFallback(), live: false };
  try {
    await connectToDatabase();
    await ensureBootstrapped();
    const vehicles = await Vehicle.find({ active: true }).sort({ sortOrder: 1, name: 1 }).lean();
    return { vehicles: vehicles.map(serializeVehicle), live: true };
  } catch (err) {
    console.warn(
      "[catalog] database unreachable — using seed vehicles:",
      err instanceof Error ? err.message : String(err),
    );
    return { vehicles: seedFallback(), live: false };
  }
}

function seedFallback(): VehicleDTO[] {
  return VEHICLE_SEEDS.map((v, i) => ({
    id: `seed-${v.slug}`,
    slug: v.slug,
    name: v.name,
    description: v.description,
    image: v.image,
    capacity: v.capacity,
    pricePerKm: v.pricePerKm,
    basePrice: v.basePrice,
    minimumFare: v.minimumFare,
    averageSpeedKmh: v.averageSpeedKmh,
    active: v.active,
    sortOrder: v.sortOrder ?? i,
  }));
}
