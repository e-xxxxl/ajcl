import { z } from "zod";
import { MAX_STOPS, PACKAGE_CATEGORIES } from "../../config/booking";

export const locationSchema = z.object({
  formattedAddress: z.string().trim().min(4, "Enter an address").max(400),
  lat: z.number().gte(-90).lte(90).optional(),
  lng: z.number().gte(-180).lte(180).optional(),
  placeId: z.string().trim().max(300).optional(),
  label: z.string().trim().max(120).optional(),
  manual: z.boolean().optional().default(false),
});

export type LocationInput = z.infer<typeof locationSchema>;

const phone = z
  .string()
  .trim()
  .min(7, "Enter a valid phone number")
  .max(20)
  .regex(/^[+]?[0-9()\s-]{7,20}$/, "Enter a valid phone number");

const contactSchema = z.object({
  name: z.string().trim().min(2, "Required").max(120),
  phone,
  email: z.string().trim().toLowerCase().email("Enter a valid email").or(z.literal("")).optional(),
});

const packageSchema = z.object({
  description: z.string().trim().min(3, "Describe the package").max(500),
  category: z.enum(PACKAGE_CATEGORIES),
  quantity: z.coerce.number().int().min(1).max(999).default(1),
  declaredValue: z.coerce.number().min(0).max(100_000_000).default(0),
  specialInstructions: z.string().trim().max(800).optional().default(""),
});

/**
 * Route metrics computed in the browser by DirectionsService. The server
 * accepts these ONLY after a sanity check against the straight-line distance
 * (see `computeRouteMetrics`).
 */
export const clientRouteSchema = z
  .object({
    distanceKm: z.number().positive().max(10_000),
    returnLegKm: z.number().min(0).max(10_000).default(0),
    durationSeconds: z.number().min(0).max(1_000_000).default(0),
    polyline: z.string().max(30_000).optional(),
  })
  .optional();

export type ClientRouteInput = NonNullable<z.infer<typeof clientRouteSchema>>;

/** Shape of the route step (used for pricing preview + booking creation). */
export const routeInputSchema = z.object({
  pickup: locationSchema,
  stops: z.array(locationSchema).max(MAX_STOPS).default([]),
  destination: locationSchema,
  deliveryType: z.enum(["single", "return"]).default("single"),
});

export type RouteInput = z.infer<typeof routeInputSchema>;

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date");
const timeStr = z.string().regex(/^\d{2}:\d{2}$/, "Choose a time");

export const priceQuoteSchema = routeInputSchema.extend({
  vehicleSlug: z.string().trim().min(1).optional(),
  clientRoute: clientRouteSchema,
});

export const createBookingSchema = routeInputSchema.extend({
  scheduledDate: dateStr,
  scheduledTime: timeStr,
  vehicleSlug: z.string().trim().min(1, "Select a vehicle"),
  sender: contactSchema,
  recipient: contactSchema,
  package: packageSchema,
  notes: z.string().trim().max(800).optional().default(""),
  clientRoute: clientRouteSchema,
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;

/** Guard: a location must be Google-resolved OR explicitly manual with text. */
export function assertRoutable(input: RouteInput) {
  const points = [input.pickup, ...input.stops, input.destination];
  for (const p of points) {
    const hasCoords = typeof p.lat === "number" && typeof p.lng === "number";
    if (!hasCoords && !p.manual) {
      throw new Error(`"${p.formattedAddress}" could not be resolved to a location.`);
    }
  }
}
