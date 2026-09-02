import { connectToDatabase } from "../db";
import { Vehicle } from "../../models/Vehicle";
import { computeRoute, haversineKm, type LatLng } from "../maps/service";
import { calculatePrice, type PricingRouteMetrics } from "../pricing/engine";
import { serializeVehicle } from "../serialize";
import { ApiError } from "../api";
import type { RouteInput, ClientRouteInput } from "../validation/booking";
import type { QuoteDTO } from "../../types";
import { FALLBACK_AVERAGE_SPEED_KMH } from "../../config/maps";

type RawLocation = {
  formattedAddress: string;
  lat?: number | null;
  lng?: number | null;
  placeId?: string | null;
  label?: string | null;
  manual?: boolean | null;
};

/** Coerce a stored booking location (nullable) into the RouteInput shape. */
function toRouteLocation(l: RawLocation): RouteInput["pickup"] {
  return {
    formattedAddress: l.formattedAddress,
    lat: l.lat ?? undefined,
    lng: l.lng ?? undefined,
    placeId: l.placeId ?? undefined,
    label: l.label ?? undefined,
    manual: l.manual ?? false,
  };
}

/** Build a RouteInput from a booking document/object. */
export function bookingToRouteInput(b: {
  pickup: RawLocation;
  stops?: RawLocation[] | null;
  destination: RawLocation;
  deliveryType: string;
}): RouteInput {
  return {
    pickup: toRouteLocation(b.pickup),
    stops: (b.stops ?? []).map(toRouteLocation),
    destination: toRouteLocation(b.destination),
    deliveryType: b.deliveryType === "return" ? "return" : "single",
  };
}

function coordsOf(input: RouteInput): { points: LatLng[]; anyMissing: boolean } {
  const all = [input.pickup, ...input.stops, input.destination];
  const points: LatLng[] = [];
  let anyMissing = false;
  for (const p of all) {
    if (typeof p.lat === "number" && typeof p.lng === "number") {
      points.push({ lat: p.lat, lng: p.lng });
    } else {
      anyMissing = true;
    }
  }
  return { points, anyMissing };
}

/** Straight-line distance across pickup → stops → destination (+ return leg). */
function haversineTotal(points: LatLng[], returnToOrigin: boolean): { total: number; lastLeg: number } {
  const path = returnToOrigin && points.length > 1 ? [...points, points[0]] : points;
  let total = 0;
  let lastLeg = 0;
  for (let i = 1; i < path.length; i += 1) {
    lastLeg = haversineKm(path[i - 1], path[i]);
    total += lastLeg;
  }
  return { total, lastLeg };
}

/**
 * Is a browser-computed distance plausible for this route?
 * Real driving distance is always ≥ the straight line and rarely more than ~4×
 * it (dense-city detours, water crossings). Outside that band we don't trust it.
 */
function isPlausible(distanceKm: number, straightLineKm: number): boolean {
  if (straightLineKm <= 0) return distanceKm > 0 && distanceKm < 2000;
  return distanceKm >= straightLineKm * 0.85 && distanceKm <= straightLineKm * 4 + 3;
}

export type RouteMetricsResult = {
  distanceKm: number;
  returnLegKm: number;
  estimatedDurationSeconds: number;
  /** "google" = Routes API or verified browser route; "estimate" = straight-line model. */
  source: "google" | "estimate";
  polyline?: string;
  stopCount: number;
};

type MetricsOptions = {
  /** Route metrics measured in the browser (DirectionsService). Verified before use. */
  clientRoute?: ClientRouteInput;
  /** Previously-stored authoritative metrics (used when re-pricing a saved booking). */
  stored?: { distanceKm: number; returnLegKm?: number; durationSeconds?: number; polyline?: string };
};

/**
 * Server-authoritative route computation.
 *
 * Priority:
 *   1. Routes API via the server key (`GOOGLE_MAPS_API_KEY`) — fully trusted.
 *   2. A browser-computed route that passes the straight-line sanity check —
 *      genuine Google data, just measured client-side.
 *   3. Straight-line distance × road factor — a rough but safe estimate.
 */
export async function computeRouteMetrics(
  input: RouteInput,
  opts: MetricsOptions = {},
): Promise<RouteMetricsResult> {
  const { points, anyMissing } = coordsOf(input);
  const returnToOrigin = input.deliveryType === "return";
  const stopCount = input.stops.length;

  if (points.length < 2) {
    return { distanceKm: 0, returnLegKm: 0, estimatedDurationSeconds: 0, source: "estimate", stopCount };
  }

  const straight = haversineTotal(points, returnToOrigin);

  // 1) Server-side Routes API.
  const server = await computeRoute(points, { returnToOrigin });
  if (server.source === "google") {
    const inflate = anyMissing ? 1.1 : 1;
    return {
      distanceKm: round2(server.distanceKm * inflate),
      returnLegKm: round2(server.returnLegKm * inflate),
      estimatedDurationSeconds:
        server.durationSeconds || Math.round((server.distanceKm / FALLBACK_AVERAGE_SPEED_KMH) * 3600),
      source: "google",
      polyline: server.polyline,
      stopCount,
    };
  }

  // 2) Verified browser route (or stored authoritative metrics).
  const candidate = opts.clientRoute ?? opts.stored;
  if (candidate && candidate.distanceKm > 0 && isPlausible(candidate.distanceKm, straight.total)) {
    const returnLegKm =
      candidate.returnLegKm && candidate.returnLegKm > 0
        ? candidate.returnLegKm
        : returnToOrigin
          ? round2(straight.lastLeg * 1.3)
          : 0;
    const durationSeconds =
      ("durationSeconds" in candidate ? candidate.durationSeconds : undefined) ||
      Math.round((candidate.distanceKm / FALLBACK_AVERAGE_SPEED_KMH) * 3600);
    return {
      distanceKm: round2(candidate.distanceKm),
      returnLegKm,
      estimatedDurationSeconds: durationSeconds,
      source: "google",
      polyline: candidate.polyline,
      stopCount,
    };
  }

  // 3) Straight-line estimate.
  const inflate = anyMissing ? 1.1 : 1;
  return {
    distanceKm: round2(server.distanceKm * inflate),
    returnLegKm: round2(server.returnLegKm * inflate),
    estimatedDurationSeconds:
      server.durationSeconds || Math.round((server.distanceKm / FALLBACK_AVERAGE_SPEED_KMH) * 3600),
    source: "estimate",
    polyline: server.polyline,
    stopCount,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Build a full quote: route metrics + a price for every active vehicle. */
export async function buildQuote(
  input: RouteInput,
  opts: MetricsOptions = {},
): Promise<QuoteDTO> {
  await connectToDatabase();
  const vehicles = await Vehicle.find({ active: true }).sort({ sortOrder: 1, name: 1 }).lean();
  if (vehicles.length === 0) {
    throw new ApiError("No vehicles are available for booking right now.", 503);
  }

  const metrics = await computeRouteMetrics(input, opts);
  if (metrics.distanceKm <= 0) {
    throw new ApiError(
      "We couldn't calculate a route. Check that the pickup and destination are valid addresses.",
      422,
    );
  }

  const priceMetrics: PricingRouteMetrics = {
    distanceKm: metrics.distanceKm,
    returnLegKm: metrics.returnLegKm,
    stopCount: metrics.stopCount,
    estimatedDurationSeconds: metrics.estimatedDurationSeconds,
  };

  return {
    distanceKm: metrics.distanceKm,
    returnLegKm: metrics.returnLegKm,
    estimatedDurationSeconds: metrics.estimatedDurationSeconds,
    routeSource: metrics.source,
    polyline: metrics.polyline,
    vehicles: vehicles.map((v) => {
      const base = metrics.estimatedDurationSeconds;
      const scaled =
        metrics.source === "google"
          ? base
          : Math.round((metrics.distanceKm / v.averageSpeedKmh) * 3600);
      return {
        vehicle: serializeVehicle(v),
        price: calculatePrice(
          {
            slug: v.slug,
            name: v.name,
            pricePerKm: v.pricePerKm,
            basePrice: v.basePrice,
            minimumFare: v.minimumFare,
          },
          { ...priceMetrics, estimatedDurationSeconds: scaled },
        ),
      };
    }),
  };
}
