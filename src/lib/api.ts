import type { Request, Response, NextFunction, RequestHandler } from "express";
import { ZodError } from "zod";
import { DatabaseNotConfiguredError } from "./db";
import { ForbiddenError, UnauthorizedError } from "./auth/middleware";

export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: string; details?: Record<string, string[]> };

export class ApiError extends Error {
  status: number;
  details?: Record<string, string[]>;
  constructor(message: string, status = 400, details?: Record<string, string[]>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

/** Send a `{ ok: true, data }` envelope. */
export function ok<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json({ ok: true, data } satisfies ApiOk<T>);
}

/** Wrap an async route handler so thrown/rejected errors reach the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Parse + validate a value against a Zod schema (throws ZodError → 422). */
export function parse<T>(schema: { parse: (v: unknown) => T }, data: unknown): T {
  return schema.parse(data);
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ ok: false, error: "Not found." } satisfies ApiErr);
}

/** Express error-handling middleware — consistent `{ ok: false, error }` responses. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const fail = (error: string, status: number, details?: Record<string, string[]>) => {
    res.status(status).json({ ok: false, error, details } satisfies ApiErr);
  };

  if (err instanceof ZodError) {
    return fail(
      "Please check the highlighted fields.",
      422,
      err.flatten().fieldErrors as Record<string, string[]>,
    );
  }
  if (err instanceof UnauthorizedError) return fail(err.message, 401);
  if (err instanceof ForbiddenError) return fail(err.message, 403);
  if (err instanceof DatabaseNotConfiguredError) {
    return fail("The database is not configured on the server.", 503);
  }
  if (err instanceof ApiError) return fail(err.message, err.status, err.details);

  // Mongo duplicate key
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: number }).code === 11000
  ) {
    return fail("That record already exists.", 409);
  }

  const name = (err as { name?: string })?.name ?? "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (
    /MongooseServerSelectionError|MongoServerSelectionError|MongoNetworkError|MongoTimeoutError/.test(
      name,
    ) ||
    /ECONNREFUSED|ETIMEDOUT|querySrv|ENOTFOUND|getaddrinfo|Server selection timed out|connection <monitor> to/i.test(
      message,
    )
  ) {
    console.error("[api] Database connection failed:", message);
    return fail(
      "The server can't reach the database. If you're using MongoDB Atlas, check that " +
        "0.0.0.0/0 is allow-listed (Atlas → Network Access) and the MONGODB_URI username, " +
        "password and database name are correct.",
      503,
    );
  }
  if (/Authentication failed|bad auth|not authorized/i.test(message)) {
    console.error("[api] Database auth failed:", message);
    return fail(
      "The database rejected the credentials. Check the username and password in MONGODB_URI " +
        "(special characters in the password must be URL-encoded).",
      503,
    );
  }

  console.error("[api] Unhandled error:", err);
  return fail("Something went wrong. Please try again.", 500);
}
