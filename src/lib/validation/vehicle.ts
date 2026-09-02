import { z } from "zod";
import { slugify } from "../utils";

export const vehicleUpsertSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .transform((s) => slugify(s))
    .optional(),
  name: z.string().trim().min(2, "Required").max(60),
  description: z.string().trim().min(10, "Add a short description").max(400),
  image: z.string().trim().max(400).optional().default(""),
  capacity: z.string().trim().max(120).optional().default(""),
  pricePerKm: z.coerce.number().min(0, "Must be 0 or more").max(1_000_000),
  basePrice: z.coerce.number().min(0).max(10_000_000).default(0),
  minimumFare: z.coerce.number().min(0).max(10_000_000).default(0),
  averageSpeedKmh: z.coerce.number().min(1).max(200).default(24),
  active: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});

export type VehicleUpsertInput = z.infer<typeof vehicleUpsertSchema>;

/**
 * Partial update schema. Every field is truly optional with NO default, so a
 * PATCH that omits a field leaves it untouched.
 */
export const vehiclePatchSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .transform((s) => slugify(s))
    .optional(),
  name: z.string().trim().min(2).max(60).optional(),
  description: z.string().trim().min(10).max(400).optional(),
  image: z.string().trim().max(400).optional(),
  capacity: z.string().trim().max(120).optional(),
  pricePerKm: z.coerce.number().min(0).max(1_000_000).optional(),
  basePrice: z.coerce.number().min(0).max(10_000_000).optional(),
  minimumFare: z.coerce.number().min(0).max(10_000_000).optional(),
  averageSpeedKmh: z.coerce.number().min(1).max(200).optional(),
  active: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
});

export type VehiclePatchInput = z.infer<typeof vehiclePatchSchema>;
