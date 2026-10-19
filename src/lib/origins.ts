import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import { env } from "./env";

/**
 * Which browser origins may call this API. FRONTEND_URL holds one or more origins separated by commas
 * (or spaces / semicolons). Each entry may be written as a full URL ("https://ajcourierlogistics.com/"),
 * or as a bare domain ("ajcourierlogistics.com"); a path and a trailing slash are ignored.
 * The www and non-www forms of a domain are both accepted, so either spelling works.
 */
function normalise(raw: string): string | null {
  let v = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    v = `${/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(v) ? "http" : "https"}://${v}`;
  }
  try {
    return new URL(v).origin.toLowerCase();
  } catch {
    return null;
  }
}

function expand(origin: string): string[] {
  const u = new URL(origin);
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return [origin];
  const host = u.hostname.startsWith("www.") ? u.hostname.slice(4) : `www.${u.hostname}`;
  return [origin, `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`];
}

export const allowedOrigins: string[] = [
  ...new Set(
    env.frontendUrls
      .flatMap((s) => s.split(/[\s,;]+/))
      .map(normalise)
      .filter((o): o is string => Boolean(o))
      .flatMap(expand),
  ),
];

export function isAllowedOrigin(origin: string | undefined | null): boolean {
  return Boolean(origin) && allowedOrigins.includes(String(origin).toLowerCase().replace(/\/+$/, ""));
}

/* The site a request came from, so links and payment returns go back to the same domain the person is on. */
const store = new AsyncLocalStorage<{ origin: string }>();

export function rememberRequestOrigin(req: Request, _res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (typeof origin === "string" && isAllowedOrigin(origin)) store.run({ origin: origin.toLowerCase() }, next);
  else next();
}

/** The origin to build return links on: the caller's own domain when allowed, else the first configured one. */
export function siteUrl(): string {
  return store.getStore()?.origin ?? allowedOrigins[0] ?? env.frontendUrl;
}
