import crypto from "node:crypto";
import { Router } from "express";
import { asyncHandler } from "../lib/api";
import { env } from "../lib/env";
import { connectToDatabase } from "../lib/db";
import { Shipment } from "../models/Shipment";
import { syncTracking, refreshWallet } from "../lib/services/shipment-terminal";

/**
 * POST /api/terminal/webhook: Terminal Africa tracking updates.
 * `express.raw` is applied to this path in server.ts (before the JSON parser), so `req.body`
 * is the exact Buffer that was signed. The signature is HMAC-SHA512 of that body, hex encoded.
 * The payload itself is never trusted: it only tells us which shipment changed, and we then
 * read the real state from Terminal.
 */
export const terminalWebhookRouter = Router();

export function verifyTerminalSignature(raw: Buffer | string, signature: string | undefined, secret: string | undefined): boolean {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha512", secret).update(raw).digest("hex");
  const given = signature.trim().toLowerCase().replace(/^sha512=/, "");
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const recent = new Map<string, number>();
function alreadySeen(eventId: string | undefined): boolean {
  if (!eventId) return false;
  const now = Date.now();
  for (const [k, t] of recent) if (now - t > 60 * 60 * 1000) recent.delete(k);
  if (recent.has(eventId)) return true;
  recent.set(eventId, now);
  return false;
}

type Payload = {
  event?: string;
  type?: string;
  event_id?: string;
  id?: string;
  data?: { shipment_id?: string; id?: string; shipment?: { shipment_id?: string }; metadata?: { reference?: string } };
};

terminalWebhookRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!env.terminal.webhookSecret) return res.status(503).json({ error: "Not configured" });

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));
    const signature = (req.headers["x-terminal-signature"] as string | undefined) ?? undefined;
    if (!verifyTerminalSignature(raw, signature, env.terminal.webhookSecret)) {
      console.warn("[terminal-webhook] rejected: bad signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    let payload: Payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const eventId = payload.event_id ?? payload.id;
    if (alreadySeen(eventId)) return res.json({ received: true, duplicate: true });

    const name = String(payload.event ?? payload.type ?? "");
    try {
      await connectToDatabase();
      if (name.startsWith("shipment")) {
        const terminalId = payload.data?.shipment_id ?? payload.data?.shipment?.shipment_id ?? payload.data?.id;
        const ref = payload.data?.metadata?.reference;
        const shipment =
          (terminalId ? await Shipment.findOne({ "terminal.shipmentId": terminalId }) : null) ??
          (ref ? await Shipment.findOne({ reference: String(ref).toUpperCase() }) : null);
        if (shipment) await syncTracking(shipment);
      } else if (name.startsWith("transaction")) {
        await refreshWallet({ alert: true });
      }
    } catch (err) {
      console.error("[terminal-webhook] handling failed", err instanceof Error ? err.message : err);
    }
    return res.json({ received: true });
  }),
);
