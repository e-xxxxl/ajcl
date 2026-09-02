import type { Request, Response, NextFunction } from "express";
import { verifySession, type SessionClaims } from "./jwt";
import { connectToDatabase } from "../db";
import { User } from "../../models/User";
import type { SessionUser } from "../../types";

export class UnauthorizedError extends Error {
  status = 401;
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  status = 403;
  constructor(message = "You do not have access to this resource") {
    super(message);
    this.name = "ForbiddenError";
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionClaims | null;
      currentUser?: SessionUser | null;
    }
  }
}

/**
 * Read `Authorization: Bearer <jwt>` and attach the verified claims to
 * `req.session` (or `null`). Never throws — route guards decide what to reject.
 */
export async function attachSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    const token =
      header && header.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    req.session = token ? await verifySession(token) : null;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireSession(req: Request): SessionClaims {
  if (!req.session) throw new UnauthorizedError();
  return req.session;
}

export function requireAdmin(req: Request): SessionClaims {
  const session = requireSession(req);
  if (session.role !== "admin") throw new ForbiddenError();
  return session;
}

/**
 * Load the full user record for the current session. Falls back to the session
 * claims when the DB is unreachable so the UI still renders.
 */
export async function getCurrentUser(req: Request): Promise<SessionUser | null> {
  const session = req.session;
  if (!session) return null;
  try {
    await connectToDatabase();
    const user = await User.findById(session.sub).lean();
    if (!user) return null;
    return {
      id: String(user._id),
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: `${user.firstName} ${user.lastName}`.trim(),
      email: user.email,
      phone: user.phone,
      role: user.role as "customer" | "admin",
    };
  } catch {
    const [firstName, ...rest] = session.name.split(" ");
    return {
      id: session.sub,
      firstName: firstName ?? "",
      lastName: rest.join(" "),
      fullName: session.name,
      email: session.email,
      phone: "",
      role: session.role,
    };
  }
}
