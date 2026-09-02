import { Router } from "express";
import { z } from "zod";
import { ok, asyncHandler, parse, ApiError } from "../lib/api";
import { requireSession } from "../lib/auth/middleware";
import { enforceRateLimit } from "../lib/rate-limit";
import { connectToDatabase } from "../lib/db";
import { Payment } from "../models/Payment";
import { serializeBooking } from "../lib/serialize";
import { env, isPaystackConfigured } from "../lib/env";
import { verifyWebhookSignature, verifyTransaction } from "../lib/paystack";
import {
  initializeBookingPayment,
  verifyAndReconcile,
  confirmMockPayment,
  reconcilePayment,
} from "../lib/services/payment";

export const paymentsRouter = Router();

const initSchema = z.object({ bookingReference: z.string().trim().min(4).max(40) });
const mockSchema = z.object({
  reference: z.string().trim().min(4).max(60),
  outcome: z.enum(["success", "fail"]),
});

/** POST /api/payments/initialize */
paymentsRouter.post(
  "/initialize",
  asyncHandler(async (req, res) => {
    const session = requireSession(req);
    enforceRateLimit(req, "payment-init", { limit: 20, windowMs: 10 * 60 * 1000 });

    const { bookingReference } = parse(initSchema, req.body);
    const result = await initializeBookingPayment(session.sub, bookingReference);

    return ok(res, { ...result, provider: isPaystackConfigured ? "paystack" : "mock" });
  }),
);

/** GET /api/payments/verify?reference=... — server-side verification after the callback. */
paymentsRouter.get(
  "/verify",
  asyncHandler(async (req, res) => {
    const session = requireSession(req);
    enforceRateLimit(req, "payment-verify", { limit: 30, windowMs: 10 * 60 * 1000 });

    const reference = typeof req.query.reference === "string" ? req.query.reference : null;
    if (!reference) throw new ApiError("Missing payment reference.", 400);

    await connectToDatabase();
    const ledger = await Payment.findOne({ reference });
    if (!ledger || String(ledger.user) !== session.sub) {
      throw new ApiError("Payment reference not found.", 404);
    }

    const outcome = await verifyAndReconcile(reference, "callback");
    return ok(res, {
      paid: outcome.paid,
      status: outcome.status,
      booking: serializeBooking(outcome.booking.toObject()),
    });
  }),
);

/** POST /api/payments/mock-confirm — DEV ONLY (no Paystack keys configured). */
paymentsRouter.post(
  "/mock-confirm",
  asyncHandler(async (req, res) => {
    const session = requireSession(req);
    if (isPaystackConfigured) throw new ApiError("Mock payments are disabled.", 400);

    const { reference, outcome } = parse(mockSchema, req.body);
    const result = await confirmMockPayment(session.sub, reference, outcome);

    return ok(res, {
      paid: result.paid,
      status: result.status,
      booking: serializeBooking(result.booking.toObject()),
    });
  }),
);

/**
 * POST /api/payments/webhook — Paystack webhook.
 * `express.raw` is applied to this path in server.ts, so `req.body` is a Buffer.
 * Verifies the HMAC signature against the raw body, then re-verifies with
 * Paystack before reconciling (the webhook body alone is never trusted).
 */
paymentsRouter.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    if (!env.paystackSecretKey) {
      return res.json({ received: true, skipped: "not configured" });
    }

    const raw = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body ?? {});
    const signature = (req.headers["x-paystack-signature"] as string | undefined) ?? null;

    if (!verifyWebhookSignature(raw, signature)) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    let event: { event?: string; data?: { reference?: string } };
    try {
      event = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const reference = event.data?.reference;
    if (!reference) return res.json({ received: true });

    if (event.event === "charge.success" || event.event === "charge.failed") {
      try {
        const verification = await verifyTransaction(reference);
        await reconcilePayment(verification, "webhook");
      } catch (err) {
        console.error("[webhook] reconcile failed", err);
      }
    }

    return res.json({ received: true });
  }),
);
