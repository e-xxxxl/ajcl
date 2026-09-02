/**
 * Pricing configuration.
 *
 * These are DEFAULT SEED values only. Real per-kilometre rates are managed by
 * the admin from the dashboard (Vehicle documents in MongoDB).
 */

export type VehicleSeed = {
  slug: string;
  name: string;
  description: string;
  image: string;
  pricePerKm: number;
  basePrice: number;
  minimumFare: number;
  capacity: string;
  averageSpeedKmh: number;
  active: boolean;
  sortOrder: number;
};

export const VEHICLE_SEEDS: VehicleSeed[] = [
  {
    slug: "bike",
    name: "Bike",
    description:
      "Fast, nimble dispatch rider for documents, parcels and small packages up to 20 kg.",
    image: "/vehicles/bike.svg",
    pricePerKm: 500,
    basePrice: 0,
    minimumFare: 0,
    capacity: "Up to 20 kg · small parcels",
    averageSpeedKmh: 22,
    active: true,
    sortOrder: 1,
  },
  {
    slug: "mini-van",
    name: "Mini Van",
    description:
      "Covered van for bulk parcels, multiple boxes, electronics and fragile items up to 500 kg.",
    image: "/vehicles/mini-van.svg",
    pricePerKm: 1300,
    basePrice: 0,
    minimumFare: 0,
    capacity: "Up to 500 kg · multiple boxes",
    averageSpeedKmh: 28,
    active: true,
    sortOrder: 2,
  },
  {
    slug: "mini-truck",
    name: "Mini Truck",
    description:
      "Open or covered mini truck for furniture, appliances, pallets and heavy loads up to 1,500 kg.",
    image: "/vehicles/mini-truck.svg",
    pricePerKm: 1700,
    basePrice: 0,
    minimumFare: 0,
    capacity: "Up to 1,500 kg · furniture & appliances",
    averageSpeedKmh: 26,
    active: true,
    sortOrder: 3,
  },
];

export const PRICING_RULES = {
  perStopFee: 0,
  returnLegMultiplier: 1,
  taxRate: 0,
  roundToNearest: 1,
  currency: "NGN" as const,
};
