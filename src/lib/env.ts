/**
 * Centralised environment access for the API.
 *
 * Server secrets are read lazily so the app can boot (and health checks can
 * respond) even when an optional integration is not configured.
 */

function get(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

/** Cloudinary credentials: either CLOUDINARY_URL (cloudinary://key:secret@cloud) or the three separate vars. */
function readCloudinary() {
  const url = get("CLOUDINARY_URL");
  if (url) {
    const m = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(url);
    if (m) return { apiKey: m[1], apiSecret: m[2], cloudName: m[3] };
  }
  return {
    cloudName: get("CLOUDINARY_CLOUD_NAME"),
    apiKey: get("CLOUDINARY_API_KEY"),
    apiSecret: get("CLOUDINARY_API_SECRET"),
  };
}

/** Terminal Africa base URL. Accepts the bare host (https://sandbox.terminal.africa) or a full /v1 URL. */
function readTerminalUrl(): string {
  const raw = get("TERMINAL_AFRICA_URL") ?? "https://api.terminal.africa";
  const trimmed = raw.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export const env = {
  port: Number(process.env.PORT) || 4000,
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd: process.env.NODE_ENV === "production",

  /**
   * Allowed frontend origins. `FRONTEND_URL` may be a single origin or a
   * comma-separated list (e.g. the prod domain + http://localhost:5173 during a
   * transition). The first entry is used to build Paystack callback URLs.
   * No trailing slashes.
   */
  frontendUrls: (get("FRONTEND_URL") ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean),
  get frontendUrl(): string {
    return this.frontendUrls[0];
  },

  mongodbUri: get("MONGODB_URI"),

  jwtSecret: get("JWT_SECRET") ?? "insecure-development-secret-change-me-please-01234567",
  sessionMaxAge: get("SESSION_MAX_AGE") ?? "7d",

  adminEmail: get("ADMIN_EMAIL"),
  adminPassword: get("ADMIN_PASSWORD"),
  adminName: get("ADMIN_NAME") ?? "AJC Admin",

  /** Optional server-side Maps key (Places New + Routes) for distance cross-checks. */
  googleMapsServerKey: get("GOOGLE_MAPS_API_KEY"),

  paystackSecretKey: get("PAYSTACK_SECRET_KEY"),
  paystackCurrency: get("PAYSTACK_CURRENCY") ?? "NGN",

  /** Assign a rider automatically once a booking is paid. Set AUTO_ASSIGN_RIDERS=false to turn off. */
  autoAssignRiders: get("AUTO_ASSIGN_RIDERS")?.toLowerCase() !== "false",
  /** A rider already holding this many active jobs is skipped by auto-assignment. */
  riderMaxActiveJobs: Math.max(1, Number(get("RIDER_MAX_ACTIVE_JOBS")) || 3),

  /** An open order is shown to a rider as "on your route" when it adds at most this many km. */
  routeDetourKm: Math.max(1, Number(get("ROUTE_DETOUR_KM")) || 6),

  /** A handover is flagged for the admin when the rider's GPS fix is further than this
   *  (metres, beyond the fix's own accuracy) from the booked address. */
  proofRadiusM: Math.max(50, Number(get("PROOF_RADIUS_M")) || 300),

  /** Proof photos are stored on Cloudinary when these are set (else in MongoDB). */
  cloudinary: { ...readCloudinary(), folder: get("CLOUDINARY_FOLDER") ?? "AJCL" },

  /**
   * Terminal Africa (interstate / international shipping). Server-side only, never sent to a browser.
   * Point TERMINAL_AFRICA_URL at https://sandbox.terminal.africa to test, https://api.terminal.africa for live.
   */
  terminal: {
    url: readTerminalUrl(),
    secretKey: get("TERMINAL_AFRICA_SECRET_KEY"),
    /** Needed by the wallet balance call; looked up automatically when unset. */
    userId: get("TERMINAL_AFRICA_USER_ID"),
    /** Signs incoming webhooks. Falls back to the secret key. */
    webhookSecret: get("TERMINAL_AFRICA_WEBHOOK_SECRET") ?? get("TERMINAL_AFRICA_SECRET_KEY"),
    /** The public address of this API, used when registering the webhook. Defaults to the address of the request. */
    apiPublicUrl: get("API_PUBLIC_URL")?.replace(/\/+$/, ""),
    /** Seconds between tracking polls for shipments webhooks may have missed (0 turns polling off). */
    pollIntervalSeconds: Number(get("TERMINAL_POLL_SECONDS") ?? 900),
  },

  /** Resend transactional email. */
  resendApiKey: get("RESEND_API_KEY"),
  /** "Name <address@domain>" — the sender address must be on a Resend-verified domain. */
  emailFrom: get("EMAIL_FROM") ?? "AJ Courier & Logistics <onboarding@resend.dev>",
  /** Where customer replies go; also the recipient for admin alerts if ADMIN_EMAIL is unset. */
  supportEmail: get("SUPPORT_EMAIL") ?? get("ADMIN_EMAIL") ?? "info@ajcourierlogistics.com",
};

/** "sk_test****0Mz3": enough to recognise a key in a log without exposing it. */
export function maskSecret(value?: string | null): string {
  if (!value) return "(not set)";
  if (value.length <= 12) return "****";
  return `${value.slice(0, 7)}****${value.slice(-4)}`;
}

export const isDatabaseConfigured = Boolean(env.mongodbUri);
export const isMapsServerConfigured = Boolean(env.googleMapsServerKey);
export const isPaystackConfigured = Boolean(env.paystackSecretKey);
export const isEmailConfigured = Boolean(env.resendApiKey);
export const isTerminalConfigured = Boolean(env.terminal.secretKey);
export const isCloudinaryConfigured = Boolean(
  env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret,
);

if (env.isProd && env.jwtSecret.startsWith("insecure-development-secret")) {
  console.warn(
    "[env] JWT_SECRET is not set in production — sessions are insecure. Set a strong JWT_SECRET.",
  );
}
