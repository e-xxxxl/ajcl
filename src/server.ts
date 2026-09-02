import "dotenv/config";
import express from "express";
import cors from "cors";
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

const app = express();

// Render / proxies sit in front — trust the first hop so `req.ip` and
// `x-forwarded-for` are meaningful for the rate limiter.
app.set("trust proxy", 1);

app.use(
  cors({
    origin: env.frontendUrls,
    credentials: false, // Bearer tokens, no cookies
  }),
);

// The Paystack webhook needs the raw body for HMAC verification — must come
// BEFORE express.json().
app.use("/api/payments/webhook", express.raw({ type: "*/*" }));
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
app.use("/api/admin", adminRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(env.port, () => {
  console.log(`[server] AJ Courier API listening on :${env.port}`);
  console.log(`[server] CORS origins: ${env.frontendUrls.join(", ")}`);
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
