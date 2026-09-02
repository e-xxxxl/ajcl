import type { Request } from "express";
import { ApiError } from "./api";

/**
 * Lightweight fixed-window rate limiter (in-memory).
 *
 * Adequate for a single-instance deployment (Render Starter). For multi-instance,
 * swap the Map for a shared store (Redis / Upstash) behind the same interface.
 */

type Bucket = { count: number; resetAt: number };
const globalForRL = globalThis as unknown as { _rlBuckets?: Map<string, Bucket> };
const buckets = globalForRL._rlBuckets ?? (globalForRL._rlBuckets = new Map());

function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return (first || req.ip || "local").trim();
}

export function rateLimit(key: string, { limit, windowMs }: { limit: number; windowMs: number }): void {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    throw new ApiError(`Too many requests. Try again in ${retryAfter}s.`, 429);
  }
}

/** Enforce a per-IP limit for a named scope. */
export function enforceRateLimit(
  req: Request,
  scope: string,
  opts: { limit: number; windowMs: number },
): void {
  rateLimit(`${scope}:${clientIp(req)}`, opts);
}

// Periodic cleanup so the map doesn't grow unbounded.
if (!globalForRL._rlBuckets || buckets.size === 0) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  }, 60_000);
  (timer as unknown as { unref?: () => void }).unref?.();
}
