import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { env } from "../env";

const secret = new TextEncoder().encode(env.jwtSecret);
const ALG = "HS256";
const ISSUER = "ajcl";

export type SessionClaims = {
  sub: string; // user id
  role: "customer" | "admin" | "rider";
  email: string;
  name: string;
  /** Admins with elevated rights (create admins, delete bookings). */
  superAdmin?: boolean;
};

function toSeconds(maxAge: string): number {
  const match = /^(\d+)\s*([smhd])$/.exec(maxAge.trim());
  if (!match) return 60 * 60 * 24 * 7;
  const n = Number(match[1]);
  const unit = match[2];
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 86400);
}

export const SESSION_MAX_AGE_SECONDS = toSeconds(env.sessionMaxAge);
/** Short session for logins without "remember me". */
export const SHORT_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

export async function signSession(
  claims: SessionClaims,
  maxAgeSeconds: number = SESSION_MAX_AGE_SECONDS,
): Promise<string> {
  return new SignJWT({ ...claims } as JWTPayload)
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + maxAgeSeconds)
    .sign(secret);
}

export type ProofClaims = { sub: string; ref: string; stage: "pickup" | "delivery" };
const PROOF_TTL_SECONDS = 15 * 60;
export const PROOF_TOKEN_TTL_SECONDS = PROOF_TTL_SECONDS;

/** Issued once a rider's handover code checks out. It is the only way to reach the
 *  final confirm step, so the code can't be skipped. Not a login session (no role). */
export async function signProofToken(claims: ProofClaims): Promise<string> {
  return new SignJWT({ typ: "handover-proof", ref: claims.ref, stage: claims.stage } as JWTPayload)
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + PROOF_TTL_SECONDS)
    .sign(secret);
}

export async function verifyProofToken(token: string): Promise<ProofClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
    if (
      payload.typ === "handover-proof" &&
      typeof payload.sub === "string" &&
      typeof payload.ref === "string" &&
      (payload.stage === "pickup" || payload.stage === "delivery")
    ) {
      return { sub: payload.sub, ref: payload.ref, stage: payload.stage };
    }
    return null;
  } catch {
    return null;
  }
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
    if (
      typeof payload.sub === "string" &&
      (payload.role === "customer" || payload.role === "admin" || payload.role === "rider") &&
      typeof payload.email === "string"
    ) {
      return {
        sub: payload.sub,
        role: payload.role,
        email: payload.email,
        name: typeof payload.name === "string" ? payload.name : "",
        superAdmin: payload.superAdmin === true,
      };
    }
    return null;
  } catch {
    return null;
  }
}
