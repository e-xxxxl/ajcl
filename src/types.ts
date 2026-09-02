import type { BookingStatus, DeliveryType, PaymentStatus } from "./config/booking";

/** Plain (serialised) shapes returned by the API. */

export type SessionUser = {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  role: "customer" | "admin";
};

export type VehicleDTO = {
  id: string;
  slug: string;
  name: string;
  description: string;
  image: string;
  capacity: string;
  pricePerKm: number;
  basePrice: number;
  minimumFare: number;
  averageSpeedKmh: number;
  active: boolean;
  sortOrder: number;
};

export type LocationDTO = {
  formattedAddress: string;
  lat?: number;
  lng?: number;
  placeId?: string;
  label?: string;
  manual?: boolean;
};

export type PriceBreakdownDTO = {
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

export type QuoteDTO = {
  distanceKm: number;
  returnLegKm: number;
  estimatedDurationSeconds: number;
  routeSource: "google" | "estimate";
  polyline?: string;
  vehicles: Array<{
    vehicle: VehicleDTO;
    price: PriceBreakdownDTO;
  }>;
};

export type ContactDTO = { name: string; phone: string; email?: string };

export type PackageDTO = {
  description: string;
  category: string;
  quantity: number;
  declaredValue: number;
  specialInstructions?: string;
};

export type BookingStatusEntryDTO = {
  status: BookingStatus;
  note?: string;
  changedByRole: "system" | "customer" | "admin";
  at: string;
};

export type BookingDTO = {
  id: string;
  bookingReference: string;
  status: BookingStatus;
  deliveryType: DeliveryType;
  pickup: LocationDTO;
  stops: LocationDTO[];
  destination: LocationDTO;
  scheduledDate: string;
  scheduledTime: string;
  scheduledAt: string;
  distanceKm: number;
  estimatedDurationSeconds: number;
  routePolyline?: string;
  vehicle: { vehicleId: string; slug: string; name: string; image?: string; pricePerKm: number };
  sender: ContactDTO;
  recipient: ContactDTO;
  package: PackageDTO;
  notes?: string;
  pricing: PriceBreakdownDTO;
  payment: {
    status: PaymentStatus;
    reference?: string;
    authorizationUrl?: string;
    amount?: number;
    currency?: string;
    channel?: string;
    paidAt?: string;
  };
  assignedDriver?: { name?: string; phone?: string };
  statusHistory: BookingStatusEntryDTO[];
  createdAt: string;
  updatedAt: string;
  customer?: { id: string; fullName: string; email: string; phone: string };
};

export type NotificationDTO = {
  id: string;
  type: string;
  title: string;
  body: string;
  href?: string;
  read: boolean;
  createdAt: string;
};
