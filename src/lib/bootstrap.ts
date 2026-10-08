import { connectToDatabase } from "./db";
import { env } from "./env";
import { User } from "../models/User";
import { Vehicle } from "../models/Vehicle";
import { Booking } from "../models/Booking";
import { VEHICLE_SEEDS } from "../config/pricing";
import { hashPassword } from "./auth/password";
import { ensureHandoverCodes } from "./services/handover";

const globalForBootstrap = globalThis as unknown as { _ajcBootstrapped?: boolean };

/**
 * Idempotent first-run setup: ensure the vehicle catalogue exists and, if
 * ADMIN_EMAIL/ADMIN_PASSWORD are set, ensure an admin account exists.
 * Runs at most once per server process.
 */
export async function ensureBootstrapped(): Promise<void> {
  if (globalForBootstrap._ajcBootstrapped) return;
  if (!env.mongodbUri) return;

  try {
    await connectToDatabase();

    const vehicleCount = await Vehicle.estimatedDocumentCount();
    if (vehicleCount === 0) {
      await Vehicle.insertMany(
        VEHICLE_SEEDS.map((v) => ({
          slug: v.slug,
          name: v.name,
          description: v.description,
          image: v.image,
          capacity: v.capacity,
          pricePerKm: v.pricePerKm,
          basePrice: v.basePrice,
          minimumFare: v.minimumFare,
          averageSpeedKmh: v.averageSpeedKmh,
          fleetSize: v.fleetSize,
          active: v.active,
          sortOrder: v.sortOrder,
        })),
      );
      console.info(`[bootstrap] seeded ${VEHICLE_SEEDS.length} vehicles`);
    } else {
      // Backfill the seed rate for any seeded vehicle that was never priced
      // (pricePerKm still 0). Never touches a vehicle an admin has already
      // configured, so it's safe to run on every boot.
      for (const v of VEHICLE_SEEDS) {
        if (v.pricePerKm <= 0) continue;
        const res = await Vehicle.updateOne(
          { slug: v.slug, pricePerKm: { $lte: 0 } },
          { $set: { pricePerKm: v.pricePerKm } },
        );
        if (res.modifiedCount > 0) {
          console.info(`[bootstrap] set ${v.slug} rate to ₦${v.pricePerKm}/km`);
        }
      }
    }

    if (env.adminEmail && env.adminPassword) {
      const existing = await User.findOne({ email: env.adminEmail.toLowerCase() }).lean();
      if (!existing) {
        const [firstName, ...rest] = (env.adminName || "AJC Admin").split(" ");
        await User.create({
          firstName: firstName || "AJC",
          lastName: rest.join(" ") || "Admin",
          email: env.adminEmail.toLowerCase(),
          phone: "0000000000",
          passwordHash: await hashPassword(env.adminPassword),
          role: "admin",
          superAdmin: true,
        });
        console.info(`[bootstrap] created super-admin account for ${env.adminEmail}`);
      } else if (
        existing.role !== "admin" ||
        !(existing as { superAdmin?: boolean }).superAdmin
      ) {
        // The bootstrap account is always the super-admin.
        await User.updateOne(
          { _id: existing._id },
          { $set: { role: "admin", superAdmin: true } },
        );
      }
    }

    // Backfill handover codes for paid, still-active bookings created before this
    // feature shipped (a fresh booking gets its codes the moment payment succeeds).
    try {
      const legacy = await Booking.find({
        "payment.status": "paid",
        status: { $in: ["confirmed", "driver_assigned", "in_transit"] },
        "handover.pickupCode": { $exists: false },
      })
        .select("_id")
        .lean();
      for (const b of legacy) {
        const full = await Booking.findById(b._id);
        if (full) await ensureHandoverCodes(full);
      }
      if (legacy.length > 0) {
        console.info(`[bootstrap] generated handover codes for ${legacy.length} existing booking(s)`);
      }
    } catch (err) {
      console.error("[bootstrap] handover code backfill failed", err);
    }

    globalForBootstrap._ajcBootstrapped = true;
  } catch (err) {
    console.error("[bootstrap] failed", err);
  }
}
