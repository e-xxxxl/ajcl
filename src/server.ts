import "dotenv/config";
import express from "express";
import cors from "cors";
import { allowedOrigins, isAllowedOrigin, rememberRequestOrigin } from "./lib/origins";
import { env } from "./lib/env";
import { connectToDatabase } from "./lib/db";
import { ensureBootstrapped } from "./lib/bootstrap";
import { attachSession } from "./lib/auth/middleware";
import { errorHandler, notFoundHandler } from "./lib/api";

import { healthRouter } from "./routes/health";
import { authRouter } from "./routes/auth";
import { mapsRouter } from "./routes/maps";
import { vehiclesRouter } from "./routes/vehicles";
import { bookingsRouter } from "./routes/bookings";
import { paymentsRouter } from "./routes/payments";
import { notificationsRouter } from "./routes/notifications";
import { adminRouter } from "./routes/admin";
import { riderRouter } from "./routes/rider";
import { trackingRouter } from "./routes/tracking";
import { partnerRouter } from "./routes/partner";
import { shipmentsRouter } from "./routes/shipments";
import { officeShipmentsRouter } from "./routes/office-shipments";
import { shippingAdminRouter } from "./routes/shipping-admin";
import { siteRouter, siteAdminRouter } from "./routes/site";
import { terminalWebhookRouter } from "./routes/terminal-webhook";
import { locationsRouter } from "./routes/locations";
import { terminalPing } from "./lib/terminal/client";
import { maskSecret } from "./lib/env";
import { startShipmentJobs } from "./lib/services/shipment-jobs";
import { ensureCloudinaryFolder } from "./lib/storage/cloudinary";

const app = express();

// Render / proxies sit in front — trust the first hop so `req.ip` and
// `x-forwarded-for` are meaningful for the rate limiter.
app.set("trust proxy", 1);

// Any number of frontend domains: FRONTEND_URL="https://one.com,https://two.com". Requests with no Origin header
// (server to server, webhooks, curl) are not browser calls and pass straight through. A browser origin that is not in
// the list simply gets no CORS headers (it is never an error on the server).
const corsOptions: cors.CorsOptions = {
  origin: (origin, cb) => cb(null, !origin || isAllowedOrigin(origin)),
  credentials: false, // Bearer tokens, no cookies
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "Accept"],
  exposedHeaders: ["Content-Disposition"],
  maxAge: 86400,
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(rememberRequestOrigin);

// The Paystack webhook needs the raw body for HMAC verification — must come
// BEFORE express.json().
app.use("/api/payments/webhook", express.raw({ type: "*/*" }));
// Terminal Africa signs the exact bytes it sends, so its webhook needs the raw body too.
app.use("/api/terminal/webhook", express.raw({ type: "*/*" }));
// Super Admin uploads (slide images, the sea flier, price list PDFs) arrive as base64.
app.use(/^\/api\/admin\/site\/(assets|price-lists|flyers)\/?$/, express.json({ limit: "12mb" }));
// Proof photos arrive as base64 on the rider's pickup/delivery confirm calls. Give only
// those two routes a bigger body; everything else stays at 1 MB.
app.use(/^\/api\/rider\/jobs\/[^/]+\/(pickup|deliver)$/, express.json({ limit: "3mb" }));
app.use(express.json({ limit: "1mb" }));

// Bearer token → req.session (never throws).
app.use(attachSession);

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "ajcl-api", health: "/api/health" });
});

app.use("/api/health", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/maps", mapsRouter);
app.use("/api/vehicles", vehiclesRouter);
app.use("/api/bookings", bookingsRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/notifications", notificationsRouter);
// Shipping and site routers sit before the generic admin router so they match first.
app.use("/api/admin/shipping", shippingAdminRouter);
app.use("/api/admin/site", siteAdminRouter);
app.use("/api/admin", adminRouter);
app.use("/api/shipments", shipmentsRouter);
app.use("/api/office/shipments", officeShipmentsRouter);
app.use("/api/site", siteRouter);
app.use("/api/locations", locationsRouter);
app.use("/api/terminal/webhook", terminalWebhookRouter);
app.use("/api/rider", riderRouter);
app.use("/api/track", trackingRouter);
app.use("/api/partner", partnerRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(env.port, () => {
  console.log(`[server] AJ Courier API listening on :${env.port}`);
  console.log(`[server] CORS origins: ${allowedOrigins.join(", ")}`);
  console.log(`[terminal] base URL ${env.terminal.url}, key ${maskSecret(env.terminal.secretKey)}`);
  // Say right away whether Terminal accepts the key, rather than waiting for a customer to hit it.
  if (env.terminal.secretKey) {
    void terminalPing().then((p) =>
      console.log(`[terminal] connection check: ${p.ok ? "OK" : "FAILED"} (HTTP ${p.status || "none"}) ${p.message}`),
    );
  }
});

// Warm the DB connection + first-run seeding in the background — don't block boot.
void (async () => {
  if (!env.mongodbUri) {
    console.warn("[server] MONGODB_URI is not set — the API will return 503 for DB-backed routes.");
    return;
  }
  try {
    await connectToDatabase();
    await ensureBootstrapped();
    console.log("[server] database connected");
    void ensureCloudinaryFolder();
    startShipmentJobs();
  } catch (err) {
    console.error("[server] initial database connection failed:", err instanceof Error ? err.message : err);
  }
})();

function shutdown(signal: string) {
  console.log(`[server] ${signal} received — shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
