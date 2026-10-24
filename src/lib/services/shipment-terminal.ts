import { connectToDatabase } from "../db";
import { Shipment, type ShipmentHydrated } from "../../models/Shipment";
import { ApiError } from "../api";
import { isTerminalConfigured } from "../env";
import { toInternationalPhone, phoneProblem } from "../phone";
import { terminal, PARCEL_NOT_FOUND, type TerminalItem, type TerminalShipmentInfo } from "../terminal/api";
import { TerminalError } from "../terminal/client";
import { getShippingSettings, exchangeRatesObject, tiersOf } from "./shipping-settings";
import { billedWeightKg, computeShippingTotal, manualShippingTotal, needsManualQuote, PricingError } from "./shipment-pricing";
import { setStatus, SYSTEM, type Actor } from "./shipments";
import { notifyCustomer, notifyOffice, notifySuperAdmins } from "./shipment-notify";
import type { ShipmentStatus } from "../../config/shipping";
import { MAX_AUTO_QUOTE_KG } from "../../config/shipping";

/**
 * Everything that talks to Terminal Africa on a shipment's behalf: building the draft,
 * fetching and pricing rates, booking, tracking, and the carrier wallet.
 */

/** Turn a Terminal failure into an error the API can return, without leaking internals. */
export function asApiError(err: unknown): never {
  if (err instanceof ApiError) throw err;
  if (err instanceof TerminalError) {
    // Customers never see the provider's name or its wording. The detail goes to the server log and the Super Admin
    // "Test connection" button.
    console.error("[terminal]", isTerminalConfigured ? `HTTP ${err.status ?? "none"}: ${err.message}` : "not configured");
    if (!isTerminalConfigured || err.status === 401) {
      throw new ApiError("Shipping quotes are unavailable right now. Please contact us and we will quote it for you.", 503);
    }
    throw new ApiError(
      err.retryable
        ? "Shipping quotes are not responding right now. Please try again in a moment."
        : "We could not get a shipping quote for this parcel. Please check the details or contact us.",
      err.retryable ? 503 : 502,
    );
  }
  if (err instanceof PricingError) throw new ApiError(err.message, 422);
  throw err;
}

/** The phone number in the form Terminal accepts, or a plain-English error that says whose number is wrong. */
function carrierPhone(raw: string, country: string, whose: string): string {
  const phone = toInternationalPhone(raw, country);
  if (!phone) throw new ApiError(`${whose} phone number "${raw}" is not valid for the carrier. ${phoneProblem(country)}.`, 422);
  return phone;
}

function partyForTerminal(p: ShipmentHydrated["receiver"], whose: string) {
  return {
    name: p.name,
    phone: carrierPhone(p.phone, p.country, whose),
    email: p.email || undefined,
    line1: p.line1,
    line2: p.line2 || undefined,
    city: p.city,
    state: p.state,
    country: p.country,
    zip: p.zip || undefined,
  };
}

function weightKg(shipment: ShipmentHydrated): number {
  return shipment.confirmed?.weightKg ?? shipment.parcel.estimatedWeightKg;
}

function termItems(shipment: ShipmentHydrated): TerminalItem[] {
  const items = shipment.parcel.items.length
    ? shipment.parcel.items
    : [{ description: shipment.parcel.description, quantity: 1, value: shipment.parcel.declaredValue ?? 0, currency: "NGN" }];
  const totalQty = items.reduce((n, i) => n + i.quantity, 0) || 1;
  const perUnit = Math.max(0.01, Math.round((weightKg(shipment) / totalQty) * 1000) / 1000);
  return items.map((i) => ({
    description: i.description,
    quantity: i.quantity,
    value: i.value,
    currency: i.currency ?? "NGN",
    weightKg: perUnit,
  }));
}

/**
 * Make sure a Terminal draft shipment exists for the current weight. Each step is cached on
 * the shipment, so a retry resumes where the last attempt stopped instead of duplicating.
 */
export async function ensureTerminalDraft(shipment: ShipmentHydrated): Promise<string> {
  const settings = await getShippingSettings();
  const t = shipment.terminal;
  const api = terminal();

  if (!t.pickupAddressId) {
    const o = settings.office;
    if (!o.line1 || !o.phone) throw new ApiError("Set the office address and phone in shipping settings first.", 422);
    // Terminal needs a postcode on every address it books a pickup from.
    if (!o.zip) throw new ApiError("Add the office postcode in shipping settings first. The carrier needs it to collect parcels.", 422);
    t.pickupAddressId = await api.createAddress({
      name: o.contactName || o.name || "AJCL office",
      phone: carrierPhone(o.phone, o.country || "NG", "The office"),
      email: o.email || undefined,
      line1: o.line1,
      line2: o.line2 || undefined,
      city: o.city || "Lagos",
      state: o.state || "Lagos",
      country: o.country || "NG",
      zip: o.zip || undefined,
    });
    await shipment.save();
  }
  if (!t.deliveryAddressId) {
    t.deliveryAddressId = await api.createAddress(partyForTerminal(shipment.receiver, "The receiver's"));
    await shipment.save();
  }
  if (!t.packagingId) {
    const d = shipment.confirmed?.dimensions ?? shipment.parcel.dimensions;
    t.packagingId = await api.createPackaging({
      name: `${shipment.reference} box`,
      weightKg: weightKg(shipment),
      lengthCm: d?.lengthCm ?? undefined,
      widthCm: d?.widthCm ?? undefined,
      heightCm: d?.heightCm ?? undefined,
    });
    await shipment.save();
  }
  if (!t.parcelId) {
    t.parcelId = await api.createParcel({
      packagingId: t.packagingId,
      items: termItems(shipment),
      description: shipment.parcel.description.slice(0, 200),
    });
    await shipment.save();
  }
  if (!t.shipmentId) {
    const make = () =>
      api.createShipment({
        fromAddressId: t.pickupAddressId!,
        toAddressId: t.deliveryAddressId!,
        parcelId: t.parcelId!,
        purpose: "commercial",
        reference: shipment.reference,
      });
    let created;
    try {
      created = await make();
    } catch (err) {
      // A parcel saved with an id the carrier does not accept for shipments: make the parcel again and retry once.
      if (!(err instanceof TerminalError) || !PARCEL_NOT_FOUND.test(err.message)) throw err;
      console.warn(`[shipments] ${shipment.reference}: parcel ${t.parcelId} was not found; creating it again`);
      t.parcelId = await api.createParcel({
        packagingId: t.packagingId!,
        items: termItems(shipment),
        description: shipment.parcel.description.slice(0, 200),
      });
      await shipment.save();
      created = await make();
    }
    t.shipmentId = created.shipmentId;
    await shipment.save();
  }
  return t.shipmentId!;
}

export type RateFetchResult = {
  options: ReturnType<typeof priceOption>[];
  warnings: string[];
};

function priceOption(
  rate: { rateId: string; carrierName: string; carrierLogo?: string; service?: string; deliveryTime?: string; amount: number; currency: string },
  ctx: { fx: Record<string, number>; fxUpdatedAt?: Date | null; billedKg: number; tiers: { minKg: number; maxKg: number; percent: number }[]; flat: number; surcharge: number },
) {
  const priced = computeShippingTotal({
    sourceAmount: rate.amount,
    sourceCurrency: rate.currency,
    fxRate: ctx.fx[rate.currency],
    billedKg: ctx.billedKg,
    tiers: ctx.tiers,
    flatFeeNgn: ctx.flat,
    surchargeNgn: ctx.surcharge,
  });
  return {
    rateId: rate.rateId,
    carrierName: rate.carrierName,
    carrierLogo: rate.carrierLogo,
    service: rate.service,
    deliveryTime: rate.deliveryTime,
    ...priced,
    fxRateUpdatedAt: priced.sourceCurrency === "NGN" ? undefined : ctx.fxUpdatedAt ?? undefined,
    manual: false,
  };
}

/**
 * International shipments are priced on the customer's own weight as soon as they are created, so they can pay
 * straight away. If anything is missing (no office postcode, no rates, a heavy parcel) nothing is offered and the
 * normal flow applies: weigh first, then quote.
 */
export async function offerPrepay(shipment: ShipmentHydrated): Promise<void> {
  if (shipment.shipmentType !== "international") return;
  try {
    const { options } = await fetchAndPriceRates(shipment);
    if (options.length > 0) {
      shipment.quote.prepayOffered = true;
      await shipment.save();
    }
  } catch (err) {
    console.warn(`[shipments] ${shipment.reference}: no advance price offered: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * The parcel has just been weighed. For a shipment that was paid for in advance, price the same carrier on the real
 * weight. Heavier (a higher billed kilogram) means the difference is asked for; the same or lighter is booked as paid.
 */
export async function settlePrepaidAfterWeigh(shipment: ShipmentHydrated, actor: Actor): Promise<ShipmentHydrated> {
  if (!shipment.prepaid || shipment.status !== "weight_confirmed") return shipment;
  const billedActual = billedWeightKg(weightKg(shipment));
  if (needsManualQuote(billedActual)) {
    await notifyOffice("admin_shipment_new", "Prepaid shipment over the weight limit", `${shipment.reference} was paid in advance but weighs over ${MAX_AUTO_QUOTE_KG} kg. Quote the difference by hand.`, shipment.reference);
    return shipment;
  }
  const carrier = shipment.quote.prepaidCarrier;
  try {
    const { options } = await fetchAndPriceRates(shipment);
    const same = options.find((o) => o.carrierName === carrier);
    if (!same) {
      await notifyOffice("admin_shipment_new", "Prepaid shipment needs a new quote", `${shipment.reference} was paid in advance with ${carrier}, which no longer offers this weight. Choose another carrier and send a quote.`, shipment.reference);
      return shipment;
    }
    const paid = shipment.shippingAmount ?? 0;
    const billedEstimate = billedWeightKg(shipment.parcel.estimatedWeightKg);
    const heavier = billedActual > billedEstimate;
    const extra = heavier ? Math.round((same.total - paid) * 100) / 100 : 0;

    shipment.quote.options = [same] as never;
    shipment.quote.selectedRateId = same.rateId;
    if (extra > 0.5) {
      shipment.quote.sentAt = new Date();
      setStatus(shipment, "quote_sent", actor, `Weighed at ${shipment.confirmed?.weightKg} kg (billed ${billedActual} kg, the customer declared ${billedEstimate} kg): additional fee ${extra}`);
      await shipment.save();
      await notifyCustomer(
        String(shipment.user),
        "shipment_quote_ready",
        "Additional shipping fee needed",
        `Your package for ${shipment.reference} weighed ${shipment.confirmed?.weightKg} kg, more than the ${shipment.parcel.estimatedWeightKg} kg you entered. Please pay the additional ${formatNaira(extra)} so we can ship it.`,
        shipment.reference,
      );
      return shipment;
    }
    setStatus(shipment, "paid", actor, "Weighed; no additional fee");
    await shipment.save();
    await notifyCustomer(String(shipment.user), "shipment_paid", "Your package is weighed", `${shipment.reference} has been weighed. There is nothing more to pay. We are booking it with the carrier now.`, shipment.reference);
    return await bookWithTerminal(String(shipment._id));
  } catch (err) {
    console.error(`[shipments] ${shipment.reference}: could not settle the advance payment: ${err instanceof Error ? err.message : err}`);
    await notifyOffice("admin_shipment_new", "Prepaid shipment needs attention", `${shipment.reference} was paid in advance and weighed, but the carrier price could not be fetched. Fetch rates and send a quote.`, shipment.reference);
    return shipment;
  }
}

/** Fetch live carrier rates and price each one with the current tiers, fees and exchange rate. */
export async function fetchAndPriceRates(shipment: ShipmentHydrated): Promise<RateFetchResult> {
  const billedKg = billedWeightKg(weightKg(shipment));
  if (needsManualQuote(billedKg)) {
    throw new ApiError(`This parcel is over ${MAX_AUTO_QUOTE_KG} kg. Enter the amount by hand instead.`, 409);
  }
  const settings = await getShippingSettings();
  const fx = exchangeRatesObject(settings);
  const currency = shipment.shipmentType === "international" ? settings.internationalQuoteCurrency || "USD" : "NGN";
  if (currency !== "NGN" && !fx[currency]) {
    throw new ApiError(`Set the ${currency} exchange rate in shipping settings before fetching rates.`, 422);
  }

  try {
    const shipmentId = await ensureTerminalDraft(shipment);
    const rates = await terminal().getRates({ shipmentId, currency });
    const warnings: string[] = [];
    const options = [];
    for (const rate of rates) {
      if (rate.currency !== "NGN" && !fx[rate.currency]) {
        warnings.push(`Skipped ${rate.carrierName}: no ${rate.currency} exchange rate is set.`);
        continue;
      }
      options.push(
        priceOption(rate, {
          fx,
          fxUpdatedAt: settings.exchangeRatesUpdatedAt,
          billedKg,
          tiers: tiersOf(settings),
          flat: settings.flatFeeNgn,
          surcharge: settings.surchargeNgn,
        }),
      );
    }
    options.sort((a, b) => a.total - b.total);
    if (options.length === 0) warnings.push("The carrier returned no rates for this route. You can enter an amount by hand.");

    shipment.quote.options = options as never;
    shipment.quote.billedWeightKg = billedKg;
    shipment.quote.selectedRateId = undefined;
    await shipment.save();
    return { options, warnings };
  } catch (err) {
    return asApiError(err);
  }
}

export function buildManualOption(amount: number, extra: { carrierName?: string; deliveryTime?: string }) {
  const priced = manualShippingTotal(amount);
  return {
    rateId: "manual",
    carrierName: extra.carrierName || "AJCL Shipping",
    deliveryTime: extra.deliveryTime,
    ...priced,
    manual: true,
  };
}

/* ── Terminal status -> our status ─────────────────────────────────────── */

export function mapTerminalStatus(raw: string): ShipmentStatus | null {
  const s = raw.toLowerCase();
  if (/deliver(ed)?$|^delivered/.test(s) && !/out_for|out-for|attempt/.test(s)) return "delivered";
  if (/fail|return|exception|undeliver|lost|damag|reject/.test(s)) return "failed";
  if (/transit|picked|pick_up|pickup_complete|out_for|out-for|shipped|dispatch|collected|arriv|depart|customs|sorting|delivery_in_progress/.test(s)) return "in_transit";
  return null;
}

const ORDER: ShipmentStatus[] = ["booked", "in_transit", "delivered"];

/** Fold a Terminal tracking snapshot into the shipment. Only moves forward, never back from delivered. */
export function applyTracking(shipment: ShipmentHydrated, info: TerminalShipmentInfo): { statusChanged: ShipmentStatus | null } {
  const t = shipment.terminal;
  t.status = info.status;
  t.lastSyncedAt = new Date();
  if (info.carrierName) t.carrierName = info.carrierName;
  if (info.trackingNumber) t.trackingNumber = info.trackingNumber;
  if (info.trackingUrl) t.trackingUrl = info.trackingUrl;

  const seen = new Set(t.events.map((e) => `${e.status}|${e.description ?? ""}|${new Date(e.at).getTime()}`));
  for (const e of info.events) {
    const key = `${e.status}|${e.description ?? ""}|${e.at.getTime()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    t.events.push({ eventId: e.eventId, status: e.status, description: [e.description, e.location].filter(Boolean).join(" - ") || undefined, at: e.at });
  }
  t.events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const current = shipment.status as ShipmentStatus;

  // A cancelled shipment gets its money back in the Terminal wallet. To send it again we need a fresh rate and a new
  // pickup (steps 4 and 5 of Terminal's guide), so it goes back to "booking failed" for staff to re-book.
  if (/cancel/i.test(info.status) && !/pending/i.test(info.status) && (current === "booked" || current === "in_transit")) {
    t.trackingNumber = undefined;
    t.trackingUrl = undefined;
    t.bookedAt = undefined;
    t.rateId = undefined;
    t.rebookRequired = true;
    t.bookingError = "The carrier cancelled this shipment and the money went back to the Terminal wallet. Book it again to get a fresh rate.";
    setStatus(shipment, "booking_failed", { name: "Carrier", role: "carrier" }, "The carrier cancelled the shipment");
    return { statusChanged: "booking_failed" };
  }

  const mapped = mapTerminalStatus(info.status) ?? latestMapped(info);
  if (!mapped || !["booked", "in_transit", "failed"].includes(current)) return { statusChanged: null };
  if (mapped === current) return { statusChanged: null };
  if (mapped === "failed") {
    setStatus(shipment, "failed", { name: "Carrier", role: "carrier" }, `Carrier status: ${info.status}`);
    return { statusChanged: "failed" };
  }
  if (ORDER.indexOf(mapped) > ORDER.indexOf(current)) {
    setStatus(shipment, mapped, { name: "Carrier", role: "carrier" }, `Carrier status: ${info.status}`);
    return { statusChanged: mapped };
  }
  return { statusChanged: null };
}

function latestMapped(info: TerminalShipmentInfo): ShipmentStatus | null {
  for (const e of [...info.events].sort((a, b) => b.at.getTime() - a.at.getTime())) {
    const m = mapTerminalStatus(e.status);
    if (m) return m;
  }
  return null;
}

async function announceTracking(shipment: ShipmentHydrated, changed: ShipmentStatus | null) {
  if (!changed) return;
  const uid = String(shipment.user);
  if (changed === "booking_failed") {
    await notifySuperAdmins(
      "admin_shipment_booking_failed",
      "Carrier cancelled a shipment",
      `${shipment.reference} was cancelled by the carrier. The money is back in the Terminal wallet. Open it and book again.`,
      `/admin/shipments/${shipment.reference}`,
    );
    await notifyCustomer(uid, "shipment_failed", "We are re-booking your shipment", `The carrier cancelled shipment ${shipment.reference}. Your payment is safe and we are arranging another pickup.`, shipment.reference);
    return;
  }
  if (changed === "in_transit") {
    await notifyCustomer(uid, "shipment_in_transit", "Your shipment is on its way", `Shipment ${shipment.reference} is in transit${shipment.terminal.trackingNumber ? `. Tracking number: ${shipment.terminal.trackingNumber}` : ""}.`, shipment.reference);
  } else if (changed === "delivered") {
    await notifyCustomer(uid, "shipment_delivered", "Your shipment was delivered", `Shipment ${shipment.reference} has been delivered.`, shipment.reference);
  } else if (changed === "failed") {
    await notifyCustomer(uid, "shipment_failed", "There is a problem with your shipment", `The carrier reported a problem with shipment ${shipment.reference}. Our team will contact you.`, shipment.reference);
    await notifyOffice("shipment_failed", "Carrier reported a problem", `${shipment.reference}: ${shipment.terminal.status ?? "delivery issue"}`, shipment.reference);
  }
}

/** Pull the latest tracking from Terminal (used by polling and by the webhook handler). */
export async function syncTracking(shipment: ShipmentHydrated): Promise<ShipmentHydrated> {
  const terminalId = shipment.terminal.shipmentId;
  if (!terminalId) return shipment;
  try {
    const info = await terminal().track(terminalId);
    const { statusChanged } = applyTracking(shipment, info);
    await shipment.save();
    await announceTracking(shipment, statusChanged);
  } catch (err) {
    if (err instanceof TerminalError) {
      console.error(`[shipments] tracking sync failed for ${shipment.reference}: ${err.message}`);
      return shipment;
    }
    throw err;
  }
  return shipment;
}

/* ── Booking (this is the step that charges the Terminal wallet) ───────── */

const BOOKABLE: ShipmentStatus[] = ["paid", "booking_failed"];

/** Shown to staff on a paid shipment that is waiting for the Terminal wallet to be funded. */
export const WALLET_WAITING = "Waiting to be booked: the Terminal wallet needs funding.";

/** Terminal's wording for an expired rate is not documented, so match on it (client errors only, never money or auth problems). */
function looksLikeStaleRate(err: unknown): boolean {
  if (!(err instanceof TerminalError) || err.walletLow || err.retryable) return false;
  if ([401, 402, 403].includes(err.status)) return false;
  return /rate|expire|invalid|no longer|not (found|available)/i.test(err.message);
}

/**
 * Ask Terminal for the shipment's rates again and take the same carrier's current one. If it now costs more than
 * what the customer paid for, stop and hand the order to an admin rather than absorbing the difference or booking.
 */
async function freshRateFor(terminalId: string, option: { carrierName: string; sourceAmount: number; sourceCurrency: string }) {
  const fresh = await terminal().getRates({ shipmentId: terminalId, currency: option.sourceCurrency });
  const same = fresh.find((r) => r.carrierName === option.carrierName);
  if (!same) throw new ApiError(`${option.carrierName} is not offering this route right now. Send the customer a new quote.`, 409);
  if (same.amount > option.sourceAmount + 0.005) {
    throw new ApiError(
      `Price changed: ${option.carrierName} now charges ${same.amount.toLocaleString("en")} ${option.sourceCurrency} (the customer paid for ${option.sourceAmount.toLocaleString("en")}). Needs your review: send a new quote or refund. It will book by itself if the price comes back down.`,
      409,
    );
  }
  return same;
}
const LOCK_MS = 2 * 60 * 1000;

export async function bookWithTerminal(shipmentId: string, actor: Actor = SYSTEM): Promise<ShipmentHydrated> {
  await connectToDatabase();
  const now = new Date();
  // Claim the booking so two requests (a webhook and a callback, or a double click) never book twice.
  const claimed = await Shipment.findOneAndUpdate(
    {
      _id: shipmentId,
      status: { $in: BOOKABLE },
      "terminal.trackingNumber": { $exists: false },
      $or: [
        { "terminal.bookingLockAt": { $exists: false } },
        { "terminal.bookingLockAt": null },
        { "terminal.bookingLockAt": { $lt: new Date(now.getTime() - LOCK_MS) } },
      ],
    },
    { $set: { "terminal.bookingLockAt": now } },
    { returnDocument: "after" },
  );
  if (!claimed) {
    const current = await Shipment.findById(shipmentId);
    if (!current) throw new ApiError("Shipment not found.", 404);
    return current;
  }
  const shipment = claimed;

  try {
    const option = shipment.quote.options.find((o) => o.rateId === shipment.quote.selectedRateId);
    if (!option) throw new ApiError("No delivery option was selected for this shipment.", 409);
    if (option.manual) {
      throw new ApiError("This shipment was quoted by hand. Book it with the carrier yourself and record the tracking number.", 409);
    }

    const terminalId = await ensureTerminalDraft(shipment);

    // After a carrier cancellation the old rate is dead: ask for rates again and take the same carrier's new one.
    let rateId = option.rateId;
    if (shipment.terminal.rebookRequired) rateId = (await freshRateFor(terminalId, option)).rateId;

    let info;
    try {
      info = await terminal().bookShipment({ shipmentId: terminalId, rateId });
    } catch (err) {
      // The rate we stored may have expired since the customer chose it. Refetch once and try that.
      if (!looksLikeStaleRate(err)) throw err;
      console.warn(`[shipments] ${shipment.reference}: rate rejected (${(err as Error).message}); refetching`);
      rateId = (await freshRateFor(terminalId, option)).rateId;
      info = await terminal().bookShipment({ shipmentId: terminalId, rateId });
    }

    shipment.terminal.shipmentId = info.shipmentId || terminalId;
    shipment.terminal.rateId = rateId;
    shipment.terminal.rebookRequired = undefined;
    shipment.terminal.carrierName = info.carrierName || option.carrierName;
    shipment.terminal.trackingNumber = info.trackingNumber;
    shipment.terminal.trackingUrl = info.trackingUrl;
    shipment.terminal.status = info.status;
    shipment.terminal.bookedAt = new Date();
    shipment.terminal.bookingError = undefined;
    shipment.terminal.lastSyncedAt = new Date();
    for (const e of info.events) {
      shipment.terminal.events.push({ eventId: e.eventId, status: e.status, description: e.description, at: e.at });
    }
    setStatus(shipment, "booked", actor, `Booked with ${shipment.terminal.carrierName}`);
    await shipment.save();

    await notifyCustomer(
      String(shipment.user),
      "shipment_booked",
      "Your shipment is booked",
      `Shipment ${shipment.reference} is booked with ${shipment.terminal.carrierName}${info.trackingNumber ? `. Tracking number: ${info.trackingNumber}` : ""}.`,
      shipment.reference,
    );
    void refreshWallet({ alert: true }).catch(() => undefined);
  } catch (err) {
    const walletLow = err instanceof TerminalError && err.walletLow;
    const message = err instanceof Error ? err.message : "Booking failed";
    console.error(`[shipments] booking ${shipment.reference} failed${walletLow ? " (wallet)" : ""}: ${message}`);

    const alreadyWaiting = shipment.terminal.bookingError === WALLET_WAITING;
    shipment.terminal.bookingError = walletLow ? WALLET_WAITING : message.slice(0, 480);
    if (walletLow) {
      // The customer has paid and the shipment sits in Terminal as a draft. An empty wallet is our business, not a
      // failure for the customer: it stays "paid", shows in the admin list as waiting to be booked, and is booked by
      // itself (or with "Book now") once the wallet is funded.
      if (shipment.status === "booking_failed") setStatus(shipment, "paid", SYSTEM, "Waiting for the Terminal wallet to be funded");
    } else if (shipment.status !== "booking_failed") {
      setStatus(shipment, "booking_failed", SYSTEM, "Carrier booking failed");
    }
    await shipment.save();

    if (walletLow) {
      // Tell the Super Admin once, not on every retry.
      if (!alreadyWaiting) {
        await notifySuperAdmins(
          "admin_shipment_booking_failed",
          "Paid shipment waiting for the Terminal wallet",
          `${shipment.reference} is paid and its draft is in Terminal, but the wallet could not cover the booking. Fund the Terminal wallet: it is booked automatically within a few minutes, or press "Book now" on the shipment. The customer has not been told of any problem.`,
          `/admin/shipments/${shipment.reference}`,
        );
      }
      void refreshWallet({ alert: true }).catch(() => undefined);
    } else {
      await notifySuperAdmins(
        "admin_shipment_booking_failed",
        "Carrier booking failed",
        `${shipment.reference} is paid but could not be booked: ${message}`,
        `/admin/shipments/${shipment.reference}`,
      );
      await notifyCustomer(
        String(shipment.user),
        "shipment_paid",
        "Payment received",
        `Your payment for ${shipment.reference} is safe. We hit a snag booking with the carrier and our team is on it.`,
        shipment.reference,
      );
    }
  } finally {
    await Shipment.updateOne({ _id: shipment._id }, { $unset: { "terminal.bookingLockAt": 1 } });
  }
  return (await Shipment.findById(shipment._id)) ?? shipment;
}

/* ── Carrier wallet ────────────────────────────────────────────────────── */

const ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export type WalletState = { balanceNgn?: number; checkedAt?: Date; lastAlertAt?: Date; error?: string };

export async function refreshWallet(opts: { alert?: boolean } = {}): Promise<WalletState> {
  const settings = await getShippingSettings();
  const prev: WalletState = {
    balanceNgn: settings.wallet?.balanceNgn ?? undefined,
    lastAlertAt: settings.wallet?.lastAlertAt ?? undefined,
  };
  const save = async (next: WalletState) => {
    settings.set("wallet", next);
    await settings.save();
    return next;
  };

  if (!isTerminalConfigured) return save({ ...prev, checkedAt: new Date(), error: "Terminal Africa is not configured." });

  try {
    const w = await terminal().getWalletBalance();
    const low = w.amount < settings.walletAlertThresholdNgn;
    const cooled = !prev.lastAlertAt || Date.now() - new Date(prev.lastAlertAt).getTime() > ALERT_COOLDOWN_MS;
    const shouldAlert = low && Boolean(opts.alert) && cooled;
    const next = await save({
      balanceNgn: w.amount,
      checkedAt: new Date(),
      lastAlertAt: shouldAlert ? new Date() : prev.lastAlertAt,
    });
    if (shouldAlert) {
      await notifySuperAdmins(
        "admin_wallet_low",
        "Carrier wallet is running low",
        `The Terminal wallet balance is ${formatNaira(w.amount)}, below your alert level of ${formatNaira(settings.walletAlertThresholdNgn)}. Top it up so paid shipments can be booked.`,
        "/admin/shipping",
      );
    }
    return next;
  } catch (err) {
    return save({
      ...prev,
      checkedAt: new Date(),
      error: err instanceof Error ? err.message.slice(0, 200) : "Could not read the wallet balance.",
    });
  }
}

function formatNaira(n: number) {
  return `₦${Math.round(n).toLocaleString("en-NG")}`;
}


/**
 * Indicative carrier options for the public quote form. Nothing is saved: the draft lives only
 * in Terminal. The final price is confirmed once the parcel has been weighed at our office.
 */
export async function estimateRates(input: {
  shipmentType: "interstate" | "international";
  country: string;
  state: string;
  city: string;
  zip?: string;
  weightKg: number;
  dimensions?: { lengthCm: number; widthCm: number; heightCm: number };
}) {
  const settings = await getShippingSettings();
  const billedKg = billedWeightKg(input.weightKg);
  if (needsManualQuote(billedKg)) {
    return { manualRequired: true, billedWeightKg: billedKg, options: [], warnings: [], fxUpdatedAt: null as string | null };
  }
  const fx = exchangeRatesObject(settings);
  let currency = input.shipmentType === "international" ? settings.internationalQuoteCurrency || "USD" : "NGN";
  if (currency !== "NGN" && !fx[currency]) {
    // No exchange rate set for that currency yet: ask Terminal for naira prices instead of refusing the quote.
    console.warn(`[shipments] no ${currency} exchange rate is set (Super Admin > Shipping); quoting in NGN`);
    currency = "NGN";
  }
  const o = settings.office;
  if (!o.line1) console.warn("[shipments] the office address is not set (Super Admin > Shipping); quoting from Lagos");

  try {
    // One call to Terminal's quote endpoint. Nothing is created in Terminal for a price check.
    const rates = await terminal().getQuotes({
      from: { city: o.city || "Lagos", state: o.state || "Lagos", country: o.country || "NG", zip: o.zip || "100001" },
      to: { city: input.city, state: input.state, country: input.country, zip: input.zip || undefined },
      weightKg: input.weightKg,
      currency,
    });

    const warnings: string[] = [];
    const options = [];
    for (const rate of rates) {
      if (rate.currency !== "NGN" && !fx[rate.currency]) continue;
      options.push(
        priceOption(rate, {
          fx,
          fxUpdatedAt: settings.exchangeRatesUpdatedAt,
          billedKg,
          tiers: tiersOf(settings),
          flat: settings.flatFeeNgn,
          surcharge: settings.surchargeNgn,
        }),
      );
    }
    options.sort((a, b) => a.total - b.total);
    return {
      manualRequired: false,
      billedWeightKg: billedKg,
      options,
      warnings,
      fxUpdatedAt: settings.exchangeRatesUpdatedAt ? new Date(settings.exchangeRatesUpdatedAt).toISOString() : null,
    };
  } catch (err) {
    // Some destinations cannot be priced without a postcode. Say so, so the customer can add it.
    if (err instanceof TerminalError && !err.retryable && /zip|post ?code|postal/i.test(err.message)) {
      console.error(`[shipments] quote needs a postcode: ${err.message}`);
      throw new ApiError("Please enter the postcode of the destination and try again.", 422);
    }
    return asApiError(err);
  }
}
