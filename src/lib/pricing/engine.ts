import { PRICING_RULES } from "../../config/pricing";

export type PricingVehicle = {
  slug: string;
  name: string;
  pricePerKm: number;
  basePrice: number;
  minimumFare: number;
};

export type PricingRouteMetrics = {
  /** Full traversed distance in km: pickup → stops → destination (+ return leg if applicable). */
  distanceKm: number;
  /** Distance of the return leg only (0 for single delivery). */
  returnLegKm: number;
  /** Number of intermediate stops. */
  stopCount: number;
  estimatedDurationSeconds: number;
};

/** Extra fee on long deliveries (Super Admin setting). Never shown to customers: it is part of their total. */
export type LongDistanceFee = { thresholdKm: number; flatNgn: number; perKmNgn: number };
/** Either the rule to apply, or an amount already decided (a booking keeps the fee it was created with). */
export type ExtraFeeInput = { fee?: LongDistanceFee | null; fixedNgn?: number };

export type PriceBreakdown = {
  /** The Super Admin's long-distance fee, already inside subtotal and total. */
  extraFee: number;
  distanceKm: number;
  billableDistanceKm: number;
  estimatedDurationSeconds: number;
  pricePerKm: number;
  basePrice: number;
  distanceCharge: number;
  stopsFee: number;
  tax: number;
  subtotal: number;
  minimumFareApplied: boolean;
  total: number;
  currency: string;
  /** Partner markup/discount that was applied to the subtotal, in percent (0 for everyone else). */
  markupPercent: number;
};

function round(value: number, nearest: number): number {
  if (nearest <= 0) return Math.round(value * 100) / 100;
  return Math.round(value / nearest) * nearest;
}

/**
 * Single source of truth for booking price. Used both for the client-side
 * preview and the authoritative server-side computation before payment.
 */
/** The long-distance fee for a delivery of this billable length: nothing at or under the threshold. */
export function longDistanceExtra(billableKm: number, fee?: LongDistanceFee | null): number {
  if (!fee || !(fee.thresholdKm > 0) || billableKm <= fee.thresholdKm) return 0;
  return round(Math.max(0, fee.flatNgn) + Math.max(0, fee.perKmNgn) * (billableKm - fee.thresholdKm), 0.01);
}

/**
 * For everyone but the Super Admin: fold the extra fee into the distance charge, so no line shows it and the lines still
 * add up to the total.
 */
export function foldExtraFee<T extends { distanceCharge: number; extraFee?: number }>(price: T): Omit<T, "extraFee"> {
  const { extraFee, ...rest } = price;
  return { ...rest, distanceCharge: round(rest.distanceCharge + (extraFee ?? 0), 0.01) } as Omit<T, "extraFee">;
}

export function calculatePrice(
  vehicle: PricingVehicle,
  metrics: PricingRouteMetrics,
  /** Admin-set partner markup (+) or discount (-), in percent. Applied to the fare before tax. */
  markupPercent = 0,
  /** The long-distance fee, for a ride delivery. Left out for anything else (a shipment pickup). */
  extra: ExtraFeeInput = {},
): PriceBreakdown {
  const { returnLegMultiplier, perStopFee, taxRate, roundToNearest, currency } = PRICING_RULES;

  const outboundKm = Math.max(0, metrics.distanceKm - metrics.returnLegKm);
  const billableDistanceKm =
    Math.round((outboundKm + metrics.returnLegKm * returnLegMultiplier) * 100) / 100;

  const distanceCharge = round(billableDistanceKm * vehicle.pricePerKm, 0.01);
  const stopsFee = round(metrics.stopCount * perStopFee, 0.01);

  const extraFee = extra.fixedNgn != null ? round(Math.max(0, extra.fixedNgn), 0.01) : longDistanceExtra(billableDistanceKm, extra.fee);
  let subtotal = round(vehicle.basePrice + distanceCharge + stopsFee + extraFee, 0.01);

  let minimumFareApplied = false;
  if (vehicle.minimumFare > 0 && subtotal < vehicle.minimumFare) {
    subtotal = vehicle.minimumFare;
    minimumFareApplied = true;
  }

  // A partner's price differs from the public price by the admin's markup. It is applied to
  // the finished fare (after the minimum fare) so a partner never pays below their own floor.
  if (markupPercent) subtotal = round(subtotal * (1 + markupPercent / 100), 0.01);

  const tax = round(subtotal * taxRate, 0.01);
  const total = round(subtotal + tax, roundToNearest);

  return {
    extraFee,
    distanceKm: Math.round(metrics.distanceKm * 100) / 100,
    billableDistanceKm,
    estimatedDurationSeconds: Math.round(metrics.estimatedDurationSeconds),
    pricePerKm: vehicle.pricePerKm,
    basePrice: vehicle.basePrice,
    distanceCharge,
    stopsFee,
    tax,
    subtotal,
    minimumFareApplied,
    total,
    currency,
    markupPercent,
  };
}

/** Convert a total in major units (₦) to the minor units Paystack expects (kobo). */
export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}
