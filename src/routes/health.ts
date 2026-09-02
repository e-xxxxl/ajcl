import { Router } from "express";
import mongoose from "mongoose";
import { connectToDatabase } from "../lib/db";
import { ok, asyncHandler } from "../lib/api";
import { env, isMapsServerConfigured, isPaystackConfigured, isEmailConfigured } from "../lib/env";

export const healthRouter = Router();

/**
 * GET /api/health — confirm the database connection and see which integrations
 * are configured. No auth required; returns no secrets.
 */
healthRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const checks: Record<string, unknown> = {
      app: "ok",
      frontendUrl: env.frontendUrl,
      mapsServer: isMapsServerConfigured ? "configured" : "not configured (browser-only)",
      paystack: isPaystackConfigured ? "configured" : "not configured (mock checkout)",
      email: isEmailConfigured ? "configured (resend)" : "not configured",
    };

    if (!env.mongodbUri) {
      checks.database = "MONGODB_URI is not set";
      return res.status(503).json({ ok: false, checks });
    }

    const uriKind = env.mongodbUri.startsWith("mongodb+srv://") ? "atlas (srv)" : "standard";
    try {
      await connectToDatabase();
      await mongoose.connection.db?.admin().ping();
      checks.database = `connected (${uriKind})`;
      return ok(res, checks);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checks.database = "connection failed";
      checks.databaseError = message.slice(0, 300);
      checks.hint =
        uriKind === "atlas (srv)"
          ? "Atlas: allow-list 0.0.0.0/0 (Network Access), and check the username / password / db name in MONGODB_URI (URL-encode special characters in the password)."
          : "No server is listening at that address. Use an Atlas mongodb+srv:// URI, or run `npm run db` for a local one.";
      return res.status(503).json({ ok: false, checks });
    }
  }),
);
