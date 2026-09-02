import { Router } from "express";
import { connectToDatabase } from "../lib/db";
import { ok, asyncHandler } from "../lib/api";
import { ensureBootstrapped } from "../lib/bootstrap";
import { Vehicle } from "../models/Vehicle";
import { serializeVehicle } from "../lib/serialize";
import { getActiveVehicles } from "../lib/services/catalog";

export const vehiclesRouter = Router();

/** GET /api/vehicles — public list of active vehicles (falls back to seeds if DB is offline). */
vehiclesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    try {
      await connectToDatabase();
      await ensureBootstrapped();
      const vehicles = await Vehicle.find({ active: true }).sort({ sortOrder: 1, name: 1 }).lean();
      return ok(res, { vehicles: vehicles.map(serializeVehicle), live: true });
    } catch {
      const { vehicles, live } = await getActiveVehicles();
      return ok(res, { vehicles, live });
    }
  }),
);
