import { MAX_AUTO_QUOTE_KG, type MarkupTier } from "../../config/shipping";

/**
 * Shipping Total = Base + Base x Tier% + flat fee + surcharge.
 *
 * Pure functions: tiers, fees and exchange rates are passed in (they come from the
 * ShippingSettings record), nothing is hard-coded here.
 */

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Weight is always rounded UP to the next whole kilogram (12.1 kg bills as 13 kg). */
export function billedWeightKg(actualKg: number): number {
  if (!Number.isFinite(actualKg) || actualKg <= 0) return 1;
  // Guard against floating point noise such as 12.000000000000002.
  return Math.max(1, Math.ceil(Math.round(actualKg * 1e6) / 1e6));
}

export function tierFor(billedKg: number, tiers: MarkupTier[]): MarkupTier | null {
  return tiers.find((t) => billedKg >= t.minKg && billedKg <= t.maxKg) ?? null;
}

/** True when the Office Admin must type the amount by hand instead of fetching rates. */
export function needsManualQuote(billedKg: number): boolean {
  return billedKg > MAX_AUTO_QUOTE_KG;
}

export type ShippingTotalInput = {
  /** What the carrier quoted, in `sourceCurrency`. */
  sourceAmount: number;
  sourceCurrency: string;
  /** NGN per 1 unit of sourceCurrency. Required (and used) when the currency is not NGN. */
  fxRate?: number;
  billedKg: number;
  tiers: MarkupTier[];
  flatFeeNgn: number;
  surchargeNgn: number;
};

export type ShippingTotal = {
  sourceAmount: number;
  sourceCurrency: string;
  fxRate: number;
  /** Carrier rate in naira, converted BEFORE the markup. */
  baseRate: number;
  tierPercent: number;
  markup: number;
  flatFee: number;
  surcharge: number;
  total: number;
};

export class PricingError extends Error {}

export function computeShippingTotal(input: ShippingTotalInput): ShippingTotal {
  const currency = input.sourceCurrency.toUpperCase();
  const fx = currency === "NGN" ? 1 : input.fxRate;
  if (!fx || !Number.isFinite(fx) || fx <= 0) {
    throw new PricingError(`No exchange rate set for ${currency}`);
  }
  if (needsManualQuote(input.billedKg)) {
    throw new PricingError(`Parcels over ${MAX_AUTO_QUOTE_KG} kg are quoted by hand`);
  }
  const tier = tierFor(input.billedKg, input.tiers);
  if (!tier) throw new PricingError(`No markup tier covers ${input.billedKg} kg`);

  const baseRate = round2(input.sourceAmount * fx);
  const markup = round2((baseRate * tier.percent) / 100);
  const total = round2(baseRate + markup + input.flatFeeNgn + input.surchargeNgn);
  return {
    sourceAmount: input.sourceAmount,
    sourceCurrency: currency,
    fxRate: fx,
    baseRate,
    tierPercent: tier.percent,
    markup,
    flatFee: input.flatFeeNgn,
    surcharge: input.surchargeNgn,
    total,
  };
}

/** A hand-entered quote: the Office Admin types the full amount the customer pays. */
export function manualShippingTotal(amountNgn: number): ShippingTotal {
  const total = round2(amountNgn);
  return {
    sourceAmount: total,
    sourceCurrency: "NGN",
    fxRate: 1,
    baseRate: total,
    tierPercent: 0,
    markup: 0,
    flatFee: 0,
    surcharge: 0,
    total,
  };
}

/** Tiers must start at 1 kg, not overlap, and leave no gaps up to the auto-quote limit. */
export function validateTiers(tiers: MarkupTier[]): string | null {
  if (tiers.length === 0) return "Add at least one weight tier";
  const sorted = [...tiers].sort((a, b) => a.minKg - b.minKg);
  if (sorted[0].minKg !== 1) return "The first tier must start at 1 kg";
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    if (!Number.isInteger(t.minKg) || !Number.isInteger(t.maxKg)) return "Tier weights must be whole kilograms";
    if (t.maxKg < t.minKg) return `Tier ${t.minKg} to ${t.maxKg} kg ends before it starts`;
    if (t.percent < 0 || t.percent > 100) return "A tier percentage must be between 0 and 100";
    const next = sorted[i + 1];
    if (next && next.minKg !== t.maxKg + 1) {
      return next.minKg <= t.maxKg
        ? `Tiers ${t.minKg} to ${t.maxKg} kg and ${next.minKg} to ${next.maxKg} kg overlap`
        : `There is a gap between ${t.maxKg} kg and ${next.minKg} kg`;
    }
  }
  if (sorted[sorted.length - 1].maxKg < MAX_AUTO_QUOTE_KG) {
    return `Tiers must cover up to ${MAX_AUTO_QUOTE_KG} kg`;
  }
  return null;
}
