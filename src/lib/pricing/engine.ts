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

export type PriceBreakdown = {
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
};

function round(value: number, nearest: number): number {
  if (nearest <= 0) return Math.round(value * 100) / 100;
  return Math.round(value / nearest) * nearest;
}

/**
 * Single source of truth for booking price. Used both for the client-side
 * preview and the authoritative server-side computation before payment.
 */
export function calculatePrice(
  vehicle: PricingVehicle,
  metrics: PricingRouteMetrics,
): PriceBreakdown {
  const { returnLegMultiplier, perStopFee, taxRate, roundToNearest, currency } = PRICING_RULES;

  const outboundKm = Math.max(0, metrics.distanceKm - metrics.returnLegKm);
  const billableDistanceKm =
    Math.round((outboundKm + metrics.returnLegKm * returnLegMultiplier) * 100) / 100;

  const distanceCharge = round(billableDistanceKm * vehicle.pricePerKm, 0.01);
  const stopsFee = round(metrics.stopCount * perStopFee, 0.01);

  let subtotal = round(vehicle.basePrice + distanceCharge + stopsFee, 0.01);

  let minimumFareApplied = false;
  if (vehicle.minimumFare > 0 && subtotal < vehicle.minimumFare) {
    subtotal = vehicle.minimumFare;
    minimumFareApplied = true;
  }

  const tax = round(subtotal * taxRate, 0.01);
  const total = round(subtotal + tax, roundToNearest);

  return {
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
  };
}

/** Convert a total in major units (₦) to the minor units Paystack expects (kobo). */
export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}
