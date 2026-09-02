import { env } from "../env";
import { MAPS_CONFIG, FALLBACK_AVERAGE_SPEED_KMH } from "../../config/maps";

export type LatLng = { lat: number; lng: number };

export type AutocompletePrediction = {
  placeId: string;
  primaryText: string;
  secondaryText: string;
  fullText: string;
};

export type ResolvedPlace = {
  placeId: string;
  formattedAddress: string;
  location: LatLng;
};

export type AutocompleteResult = {
  predictions: AutocompletePrediction[];
  /** Present when Google rejected the request (bad key, API not enabled, …). */
  error?: string;
};

function describeGoogleError(status: number, body: string): string {
  const b = body.toLowerCase();
  if (b.includes("referer") || b.includes("referrer")) {
    return "The GOOGLE_MAPS_API_KEY has an HTTP-referrer restriction. Server-side keys must be unrestricted or IP-restricted — create a separate key for the server.";
  }
  if (b.includes("has not been used") || b.includes("is disabled") || b.includes("not enabled")) {
    return 'Enable "Places API (New)" (for autocomplete) and "Routes API" (for distance) for this key\'s Google Cloud project. Note: legacy "Places API" is a different product.';
  }
  if (b.includes("api_key_invalid") || b.includes("api key not valid")) {
    return "GOOGLE_MAPS_API_KEY is not valid.";
  }
  if (status === 403 || b.includes("permission_denied") || b.includes("request_denied")) {
    return "Google denied the request. Check the key's API restrictions include Places API (New) and Routes API.";
  }
  return `Google Maps request failed (${status}).`;
}

export type RouteResult = {
  distanceKm: number;
  returnLegKm: number;
  durationSeconds: number;
  polyline?: string;
  /** "google" = Routes API, "estimate" = haversine fallback. */
  source: "google" | "estimate";
};

const isConfigured = () => Boolean(env.googleMapsServerKey);

/* ────────────────────────────── Autocomplete ────────────────────────────── */

export async function autocomplete(
  input: string,
  sessionToken?: string,
): Promise<AutocompleteResult> {
  if (!isConfigured() || input.trim().length < MAPS_CONFIG.autocompleteMinChars) {
    return { predictions: [] };
  }

  let res: Response;
  try {
    res = await fetch(MAPS_CONFIG.placesAutocompleteUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env.googleMapsServerKey as string,
        "X-Goog-FieldMask":
          "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat",
      },
      body: JSON.stringify({
        input,
        sessionToken,
        languageCode: MAPS_CONFIG.language,
        regionCode: MAPS_CONFIG.region.toUpperCase(),
      }),
    });
  } catch (err) {
    console.error("[maps] autocomplete request threw", err);
    return { predictions: [], error: "Could not reach Google Maps." };
  }

  if (!res.ok) {
    const body = await safeText(res);
    const error = describeGoogleError(res.status, body);
    console.error(`[maps] autocomplete failed (${res.status}): ${error}\n${body}`);
    return { predictions: [], error };
  }

  const json = (await res.json()) as {
    suggestions?: Array<{
      placePrediction?: {
        placeId: string;
        structuredFormat?: {
          mainText?: { text: string };
          secondaryText?: { text: string };
        };
      };
    }>;
  };

  const predictions = (json.suggestions ?? [])
    .map((s) => s.placePrediction)
    .filter((p): p is NonNullable<typeof p> => Boolean(p?.placeId))
    .map((p) => {
      const primary = p.structuredFormat?.mainText?.text ?? "";
      const secondary = p.structuredFormat?.secondaryText?.text ?? "";
      return {
        placeId: p.placeId,
        primaryText: primary,
        secondaryText: secondary,
        fullText: [primary, secondary].filter(Boolean).join(", "),
      };
    });

  return { predictions };
}

/* ───────────────────────────── Place Details ────────────────────────────── */

export async function placeDetails(
  placeId: string,
  sessionToken?: string,
): Promise<ResolvedPlace | null> {
  if (!isConfigured()) return null;

  const url = new URL(MAPS_CONFIG.placeDetailsUrl(placeId));
  if (sessionToken) url.searchParams.set("sessionToken", sessionToken);
  url.searchParams.set("languageCode", MAPS_CONFIG.language);

  const res = await fetch(url, {
    headers: {
      "X-Goog-Api-Key": env.googleMapsServerKey as string,
      "X-Goog-FieldMask": "id,formattedAddress,location",
    },
  });

  if (!res.ok) {
    const body = await safeText(res);
    console.error(
      `[maps] place details failed (${res.status}): ${describeGoogleError(res.status, body)}\n${body}`,
    );
    return null;
  }

  const json = (await res.json()) as {
    id: string;
    formattedAddress?: string;
    location?: { latitude: number; longitude: number };
  };

  if (!json.location) return null;
  return {
    placeId: json.id,
    formattedAddress: json.formattedAddress ?? "",
    location: { lat: json.location.latitude, lng: json.location.longitude },
  };
}

/* ──────────────────────────────── Routing ───────────────────────────────── */

export async function computeRoute(
  points: LatLng[],
  opts: { returnToOrigin?: boolean } = {},
): Promise<RouteResult> {
  const full = opts.returnToOrigin && points.length > 1 ? [...points, points[0]] : points;

  if (full.length < 2) {
    return { distanceKm: 0, returnLegKm: 0, durationSeconds: 0, source: "estimate" };
  }

  if (isConfigured()) {
    const viaGoogle = await computeRouteViaGoogle(full);
    if (viaGoogle) {
      const returnLegKm = opts.returnToOrigin ? (viaGoogle.legKm.at(-1) ?? 0) : 0;
      return {
        distanceKm: round2(viaGoogle.distanceKm),
        returnLegKm: round2(returnLegKm),
        durationSeconds: Math.round(viaGoogle.durationSeconds),
        polyline: viaGoogle.polyline,
        source: "google",
      };
    }
  }

  // Fallback: sum haversine distances between consecutive points.
  let total = 0;
  const legKm: number[] = [];
  for (let i = 1; i < full.length; i += 1) {
    const d = haversineKm(full[i - 1], full[i]);
    legKm.push(d);
    total += d;
  }
  const ROUTING_FACTOR = 1.35;
  const distanceKm = total * ROUTING_FACTOR;
  const returnLegKm = opts.returnToOrigin ? (legKm.at(-1) ?? 0) * ROUTING_FACTOR : 0;
  const durationSeconds = (distanceKm / FALLBACK_AVERAGE_SPEED_KMH) * 3600;

  return {
    distanceKm: round2(distanceKm),
    returnLegKm: round2(returnLegKm),
    durationSeconds: Math.round(durationSeconds),
    source: "estimate",
  };
}

async function computeRouteViaGoogle(points: LatLng[]): Promise<{
  distanceKm: number;
  durationSeconds: number;
  legKm: number[];
  polyline?: string;
} | null> {
  const [origin, ...rest] = points;
  const destination = rest.pop() as LatLng;
  const intermediates = rest;

  try {
    const res = await fetch(MAPS_CONFIG.computeRoutesUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env.googleMapsServerKey as string,
        "X-Goog-FieldMask":
          "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.distanceMeters,routes.legs.duration",
      },
      body: JSON.stringify({
        origin: { location: { latLng: toLatLng(origin) } },
        destination: { location: { latLng: toLatLng(destination) } },
        intermediates: intermediates.map((p) => ({ location: { latLng: toLatLng(p) } })),
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        units: "METRIC",
      }),
    });

    if (!res.ok) {
      const body = await safeText(res);
      console.error(
        `[maps] computeRoutes failed (${res.status}): ${describeGoogleError(res.status, body)}` +
          ` — falling back to a straight-line distance estimate.\n${body}`,
      );
      return null;
    }

    const json = (await res.json()) as {
      routes?: Array<{
        distanceMeters?: number;
        duration?: string;
        polyline?: { encodedPolyline?: string };
        legs?: Array<{ distanceMeters?: number; duration?: string }>;
      }>;
    };

    const route = json.routes?.[0];
    if (!route?.distanceMeters) return null;

    return {
      distanceKm: route.distanceMeters / 1000,
      durationSeconds: parseDuration(route.duration),
      legKm: (route.legs ?? []).map((l) => (l.distanceMeters ?? 0) / 1000),
      polyline: route.polyline?.encodedPolyline,
    };
  } catch (err) {
    console.error("[maps] computeRoutes threw", err);
    return null;
  }
}

/* ──────────────────────────────── helpers ───────────────────────────────── */

function toLatLng(p: LatLng) {
  return { latitude: p.lat, longitude: p.lng };
}

function parseDuration(value?: string): number {
  if (!value) return 0;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(value);
  return m ? Number(m[1]) : 0;
}

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

const toRad = (deg: number) => (deg * Math.PI) / 180;
const round2 = (n: number) => Math.round(n * 100) / 100;

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
