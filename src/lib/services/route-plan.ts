/**
 * Route planning for riders.
 *
 *  - planRoute: puts a rider's active jobs into one efficient stop order.
 *  - detourFor: how many extra km an open order would add to that route.
 *
 * Distances are straight-line (haversine) scaled by a road factor, which is
 * accurate enough to rank stops and orders without a paid routing call per request.
 * Stops without coordinates (an address typed by hand) are kept in their job's
 * order and treated as zero distance from their neighbours.
 */

export type Pt = { lat: number; lng: number };

export type StopLocation = {
  formattedAddress: string;
  details?: string | null;
  name?: string | null;
  area?: string | null;
  city?: string | null;
  state?: string | null;
  lat?: number | null;
  lng?: number | null;
};

export type PlannerJob = {
  bookingReference: string;
  status: string;
  deliveryType?: string | null;
  scheduledAt?: Date | string | null;
  scheduledDate?: string | null;
  pickup: StopLocation;
  stops?: StopLocation[] | null;
  destination: StopLocation;
};

export type StopKind = "pickup" | "stop" | "dropoff" | "return";

export type RouteStop = {
  jobRef: string;
  kind: StopKind;
  label: string;
  location: StopLocation;
  /** Approx. road km from the previous stop (or from the rider, if known). null = unknown. */
  legKm: number | null;
  cumulativeKm: number;
  scheduledAt?: string;
};

export type RoutePlan = { stops: RouteStop[]; totalKm: number; mapsUrl: string | null };

/** Straight-line distance is shorter than the road. This is a typical city ratio. */
export const ROAD_FACTOR = 1.3;

const toRad = (d: number) => (d * Math.PI) / 180;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function haversineKm(a: Pt, b: Pt): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pointOf(l: StopLocation | null | undefined): Pt | null {
  if (!l || typeof l.lat !== "number" || typeof l.lng !== "number") return null;
  return { lat: l.lat, lng: l.lng };
}

/** Approx. road km between two points; 0 when either position is unknown. */
function roadKm(a: Pt | null, b: Pt | null): number {
  if (!a || !b) return 0;
  return haversineKm(a, b) * ROAD_FACTOR;
}

type Node = { jobRef: string; kind: StopKind; label: string; location: StopLocation; at?: string };

/** The stops a job still needs, in the order they must be visited. */
function chainFor(job: PlannerJob): Node[] {
  const at = job.scheduledAt ? new Date(job.scheduledAt).toISOString() : undefined;
  const ref = job.bookingReference;
  const nodes: Node[] = [];
  // Already picked up (in transit): the pickup is behind the rider.
  if (job.status !== "in_transit") {
    nodes.push({ jobRef: ref, kind: "pickup", label: "Pickup", location: job.pickup, at });
  }
  (job.stops ?? []).forEach((s, i) =>
    nodes.push({ jobRef: ref, kind: "stop", label: `Stop ${i + 1}`, location: s, at }),
  );
  nodes.push({ jobRef: ref, kind: "dropoff", label: "Drop-off", location: job.destination, at });
  if (job.deliveryType === "return") {
    nodes.push({ jobRef: ref, kind: "return", label: "Return to pickup", location: job.pickup, at });
  }
  return nodes;
}

function mapsLink(stops: RouteStop[]): string | null {
  if (stops.length === 0) return null;
  const text = (s: RouteStop) => {
    const p = pointOf(s.location);
    return p ? `${p.lat},${p.lng}` : s.location.formattedAddress;
  };
  // Google caps waypoints at 9. Drop consecutive duplicates (e.g. pickup == return).
  const seq = stops.filter((s, i) => i === 0 || text(s) !== text(stops[i - 1]));
  const dest = seq[seq.length - 1];
  const via = seq.slice(0, -1).slice(0, 9);
  const params = new URLSearchParams({ api: "1", destination: text(dest), travelmode: "driving" });
  if (via.length) params.set("waypoints", via.map(text).join("|"));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * Order a rider's active jobs into one route. Jobs are handled day by day (a job
 * for tomorrow never jumps ahead of one for today). Within a day it's greedy
 * nearest-next over each job's own chain, so a job's pickup always comes before
 * its stops and drop-off.
 */
export function planRoute(jobs: PlannerJob[], origin?: Pt | null): RoutePlan {
  const sorted = [...jobs].sort(
    (a, b) =>
      new Date(a.scheduledAt ?? 0).getTime() - new Date(b.scheduledAt ?? 0).getTime(),
  );
  const days = new Map<string, PlannerJob[]>();
  for (const j of sorted) {
    const key = j.scheduledDate ?? (j.scheduledAt ? new Date(j.scheduledAt).toISOString().slice(0, 10) : "");
    days.set(key, [...(days.get(key) ?? []), j]);
  }

  const stops: RouteStop[] = [];
  let current: Pt | null = origin ?? null;
  let cumulative = 0;

  for (const dayJobs of days.values()) {
    const chains = dayJobs.map(chainFor);
    while (chains.some((c) => c.length > 0)) {
      const open = chains.filter((c) => c.length > 0);
      let best = open[0];
      if (current) {
        let bestKm = Infinity;
        for (const c of open) {
          const km = roadKm(current, pointOf(c[0].location));
          // With unknown coordinates (km 0) keep the earlier-scheduled job first.
          if (km < bestKm) {
            bestKm = km;
            best = c;
          }
        }
      }
      const node = best.shift() as Node;
      const here = pointOf(node.location);
      const leg = current && here ? roadKm(current, here) : null;
      if (leg) cumulative += leg;
      stops.push({
        jobRef: node.jobRef,
        kind: node.kind,
        label: node.label,
        location: node.location,
        legKm: leg === null ? null : round1(leg),
        cumulativeKm: round1(cumulative),
        scheduledAt: node.at,
      });
      if (here) current = here;
    }
  }

  return { stops, totalKm: round1(cumulative), mapsUrl: mapsLink(stops) };
}

function pathLength(pts: Pt[]): number {
  let km = 0;
  for (let i = 1; i < pts.length; i += 1) km += roadKm(pts[i - 1], pts[i]);
  return km;
}

/**
 * Extra km an order (pickup then drop-off, in that order) adds to an existing
 * path, using the cheapest way to slot both in. `path` is the rider's origin (if
 * known) followed by their remaining stops. Returns null when there is no path to
 * compare against (no location and no active jobs).
 */
export function detourFor(path: Pt[], pickup: Pt, dropoff: Pt): number | null {
  if (path.length === 0) return null;
  const base = pathLength(path);
  let best = Infinity;
  for (let i = 0; i <= path.length; i += 1) {
    for (let j = i; j <= path.length; j += 1) {
      const next = [...path.slice(0, i), pickup, ...path.slice(i, j), dropoff, ...path.slice(j)];
      best = Math.min(best, pathLength(next));
    }
  }
  return round1(Math.max(0, best - base));
}
