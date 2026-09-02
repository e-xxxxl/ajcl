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

  /** Resend transactional email. */
  resendApiKey: get("RESEND_API_KEY"),
  /** "Name <address@domain>" — the sender address must be on a Resend-verified domain. */
  emailFrom: get("EMAIL_FROM") ?? "AJ Courier & Logistics <onboarding@resend.dev>",
  /** Where customer replies go; also the recipient for admin alerts if ADMIN_EMAIL is unset. */
  supportEmail: get("SUPPORT_EMAIL") ?? get("ADMIN_EMAIL") ?? "info@ajcourierlogistics.com",
};

export const isDatabaseConfigured = Boolean(env.mongodbUri);
export const isMapsServerConfigured = Boolean(env.googleMapsServerKey);
export const isPaystackConfigured = Boolean(env.paystackSecretKey);
export const isEmailConfigured = Boolean(env.resendApiKey);

if (env.isProd && env.jwtSecret.startsWith("insecure-development-secret")) {
  console.warn(
    "[env] JWT_SECRET is not set in production — sessions are insecure. Set a strong JWT_SECRET.",
  );
}
