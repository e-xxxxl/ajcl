import { Router } from "express";
import { z } from "zod";
import { ok, asyncHandler, parse, ApiError } from "../lib/api";
import { requireAdmin, requireSuperAdmin } from "../lib/auth/middleware";
import { connectToDatabase } from "../lib/db";
import { Shipment } from "../models/Shipment";
import { getShippingSettings, exchangeRatesObject, tiersOf } from "../lib/services/shipping-settings";
import { validateTiers } from "../lib/services/shipment-pricing";
import { refreshWallet } from "../lib/services/shipment-terminal";
import { isTerminalConfigured, env } from "../lib/env";
import { terminalPing } from "../lib/terminal/client";
import { terminal } from "../lib/terminal/api";
import { TerminalError } from "../lib/terminal/client";
import { MAX_AUTO_QUOTE_KG } from "../config/shipping";

/** Super Admin controls for shipping: price tiers, fees, exchange rates, wallet, policy text and the office. */
export const shippingAdminRouter = Router();

async function settingsDto() {
  const s = await getShippingSettings();
  const w = s.wallet;
  const low = w?.balanceNgn != null && w.balanceNgn < s.walletAlertThresholdNgn;
  return {
    markupTiers: tiersOf(s),
    flatFeeNgn: s.flatFeeNgn,
    surchargeNgn: s.surchargeNgn,
    exchangeRates: exchangeRatesObject(s),
    exchangeRatesUpdatedAt: s.exchangeRatesUpdatedAt ? new Date(s.exchangeRatesUpdatedAt).toISOString() : null,
    internationalQuoteCurrency: s.internationalQuoteCurrency,
    walletAlertThresholdNgn: s.walletAlertThresholdNgn,
    wallet: {
      balanceNgn: w?.balanceNgn ?? null,
      checkedAt: w?.checkedAt ? new Date(w.checkedAt).toISOString() : null,
      error: w?.error ?? null,
      low,
    },
    refundPolicyText: s.refundPolicyText,
    dutiesNotice: s.dutiesNotice,
    disclaimerParagraphs: s.disclaimerParagraphs,
    office: {
      name: s.office.name,
      contactName: s.office.contactName,
      phone: s.office.phone,
      email: s.office.email,
      line1: s.office.line1,
      line2: s.office.line2,
      city: s.office.city,
      state: s.office.state,
      country: s.office.country,
      zip: s.office.zip,
      lat: s.office.lat ?? null,
      lng: s.office.lng ?? null,
      openingHours: s.office.openingHours,
    },
    terminal: {
      configured: isTerminalConfigured,
      sandbox: /sandbox/i.test(env.terminal.url),
    },
    maxAutoQuoteKg: MAX_AUTO_QUOTE_KG,
  };
}

/** GET /api/admin/shipping/settings */
shippingAdminRouter.get(
  "/settings",
  asyncHandler(async (req, res) => {
    requireSuperAdmin(req);
    await connectToDatabase();
    return ok(res, { settings: await settingsDto() });
  }),
);

const tierSchema = z.object({
  minKg: z.coerce.number().int().min(1),
  maxKg: z.coerce.number().int().min(1),
  percent: z.coerce.number().min(0).max(100),
});

const officeSchema = z.object({
  name: z.string().trim().max(120),
  contactName: z.string().trim().max(120),
  phone: z.string().trim().max(30),
  email: z.string().trim().max(160),
  line1: z.string().trim().max(200),
  line2: z.string().trim().max(200),
  city: z.string().trim().max(100),
  state: z.string().trim().max(100),
  country: z.string().trim().toUpperCase().length(2),
  zip: z.string().trim().max(20),
  lat: z.coerce.number().min(-90).max(90).nullable().optional(),
  lng: z.coerce.number().min(-180).max(180).nullable().optional(),
  openingHours: z.string().trim().max(200),
});

const settingsSchema = z
  .object({
    markupTiers: z.array(tierSchema).min(1).max(20),
    flatFeeNgn: z.coerce.number().min(0).max(10_000_000),
    surchargeNgn: z.coerce.number().min(0).max(10_000_000),
    exchangeRates: z.record(z.string().trim().toUpperCase().length(3), z.coerce.number().positive().max(1_000_000)),
    internationalQuoteCurrency: z.string().trim().toUpperCase().length(3),
    walletAlertThresholdNgn: z.coerce.number().min(0).max(1_000_000_000),
    refundPolicyText: z.string().trim().min(1).max(3000),
    dutiesNotice: z.string().trim().min(1).max(600),
    disclaimerParagraphs: z.array(z.string().trim().min(1).max(800)).min(1).max(8),
    office: officeSchema,
  })
  .partial();

/** PUT /api/admin/shipping/settings: send only what changed. */
shippingAdminRouter.put(
  "/settings",
  asyncHandler(async (req, res) => {
    const me = requireSuperAdmin(req);
    await connectToDatabase();
    const input = parse(settingsSchema, req.body);
    const s = await getShippingSettings();

    if (input.markupTiers) {
      const problem = validateTiers(input.markupTiers);
      if (problem) throw new ApiError(problem, 422);
      s.set("markupTiers", [...input.markupTiers].sort((a, b) => a.minKg - b.minKg));
    }
    if (input.flatFeeNgn !== undefined) s.flatFeeNgn = input.flatFeeNgn;
    if (input.surchargeNgn !== undefined) s.surchargeNgn = input.surchargeNgn;
    if (input.walletAlertThresholdNgn !== undefined) s.walletAlertThresholdNgn = input.walletAlertThresholdNgn;
    if (input.refundPolicyText !== undefined) s.refundPolicyText = input.refundPolicyText;
    if (input.dutiesNotice !== undefined) s.dutiesNotice = input.dutiesNotice;
    if (input.disclaimerParagraphs !== undefined) s.set("disclaimerParagraphs", input.disclaimerParagraphs);
    if (input.internationalQuoteCurrency !== undefined) s.internationalQuoteCurrency = input.internationalQuoteCurrency;
    if (input.office) {
      s.set("office", { ...input.office, lat: input.office.lat ?? undefined, lng: input.office.lng ?? undefined });
    }
    if (input.exchangeRates) {
      const before = exchangeRatesObject(s);
      const changed = Object.keys({ ...before, ...input.exchangeRates }).some((k) => before[k] !== input.exchangeRates![k]);
      s.set("exchangeRates", input.exchangeRates);
      if (changed) s.exchangeRatesUpdatedAt = new Date();
    }
    if (input.internationalQuoteCurrency && input.internationalQuoteCurrency !== "NGN") {
      const rates = input.exchangeRates ?? exchangeRatesObject(s);
      if (!rates[input.internationalQuoteCurrency]) {
        throw new ApiError(`Add an exchange rate for ${input.internationalQuoteCurrency} so international quotes can be priced.`, 422);
      }
    }
    await s.save();
    console.info(`[shipping] ${me.email} updated shipping settings (${Object.keys(input).join(", ")})`);
    return ok(res, { settings: await settingsDto() });
  }),
);

/** POST /api/admin/shipping/wallet/refresh: read the live carrier wallet balance. */
shippingAdminRouter.post(
  "/wallet/refresh",
  asyncHandler(async (req, res) => {
    requireSuperAdmin(req);
    await connectToDatabase();
    await refreshWallet({ alert: true });
    return ok(res, { settings: await settingsDto() });
  }),
);

/**
 * GET /api/admin/shipping/summary: counts for the dashboard, plus the wallet banner for Super Admins.
 * The balance is refreshed in the background when it is more than 10 minutes old.
 */
shippingAdminRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const me = requireAdmin(req);
    await connectToDatabase();
    const s = await getShippingSettings();

    const [counts] = await Promise.all([
      Shipment.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    const by = Object.fromEntries(counts.map((c: { _id: string; n: number }) => [c._id, c.n]));

    let wallet: { balanceNgn: number | null; low: boolean; error: string | null; thresholdNgn: number } | null = null;
    if (me.superAdmin) {
      const checkedAt = s.wallet?.checkedAt ? new Date(s.wallet.checkedAt).getTime() : 0;
      if (isTerminalConfigured && Date.now() - checkedAt > 10 * 60 * 1000) void refreshWallet({ alert: true }).catch(() => undefined);
      const bal = s.wallet?.balanceNgn ?? null;
      wallet = {
        balanceNgn: bal,
        low: bal != null && bal < s.walletAlertThresholdNgn,
        error: s.wallet?.error ?? null,
        thresholdNgn: s.walletAlertThresholdNgn,
      };
    }

    return ok(res, {
      counts: by,
      needsAttention: {
        toReceive: (by.awaiting_dropoff ?? 0) + (by.awaiting_pickup ?? 0) + (by.in_transit_to_office ?? 0),
        toWeigh: (by.received_at_office ?? 0) + (by.weight_confirmed ?? 0),
        bookingFailed: by.booking_failed ?? 0,
        paid: by.paid ?? 0,
      },
      wallet,
    });
  }),
);

/** POST /api/admin/shipping/terminal-check: shows exactly what Terminal Africa answers to a real call. */
shippingAdminRouter.post(
  "/terminal-check",
  asyncHandler(async (req, res) => {
    requireSuperAdmin(req);
    return ok(res, { check: await terminalPing() });
  }),
);

/* ── Terminal webhook registration ────────────────────────────────────────
   Terminal only sends tracking updates to an address you have registered with it. */

const WEBHOOK_EVENTS = [
  "shipment.created",
  "shipment.updated",
  "shipment.in-transit",
  "shipment.delivered",
  "shipment.cancelled",
  "shipment.pending-cancellation",
  "shipment.returned",
  "shipment.awaiting-clearance",
  "shipment.customs_event",
  "transaction.success",
  "transaction.failed",
];

function webhookUrl(req: import("express").Request): string {
  const base = env.terminal.apiPublicUrl ?? `${req.protocol}://${req.get("host")}`;
  return `${base}/api/terminal/webhook`;
}

function terminalFailure(err: unknown): never {
  if (err instanceof TerminalError) throw new ApiError(err.message, err.retryable ? 503 : 502);
  throw err;
}

/** GET /api/admin/shipping/webhook: is our address registered with Terminal? */
shippingAdminRouter.get(
  "/webhook",
  asyncHandler(async (req, res) => {
    requireSuperAdmin(req);
    const url = webhookUrl(req);
    if (!isTerminalConfigured) return ok(res, { url, registered: false, configured: false });
    try {
      const hooks = await terminal().listWebhooks();
      const mine = hooks.find((h) => h.url === url);
      return ok(res, { url, configured: true, registered: Boolean(mine), active: mine?.active ?? false, events: mine?.events ?? [] });
    } catch (err) {
      return terminalFailure(err);
    }
  }),
);

/** POST /api/admin/shipping/webhook/register */
shippingAdminRouter.post(
  "/webhook/register",
  asyncHandler(async (req, res) => {
    requireSuperAdmin(req);
    const url = webhookUrl(req);
    const live = !/sandbox/i.test(env.terminal.url);
    if (live && !url.startsWith("https://")) {
      throw new ApiError("Terminal only sends live updates to an https address. Set API_PUBLIC_URL to this API's https address.", 422);
    }
    try {
      const hooks = await terminal().listWebhooks();
      if (hooks.some((h) => h.url === url)) return ok(res, { url, registered: true, alreadyRegistered: true });
      const created = await terminal().createWebhook({ name: "AJ Courier tracking", url, events: WEBHOOK_EVENTS, live });
      return ok(res, { url, registered: true, alreadyRegistered: false, webhookId: created.id });
    } catch (err) {
      return terminalFailure(err);
    }
  }),
);
