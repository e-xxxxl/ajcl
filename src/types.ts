import type { BookingStatus, DeliveryType, PaymentStatus } from "./config/booking";

/** Plain (serialised) shapes returned by the API. */

export type SessionUser = {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  role: "customer" | "admin" | "rider";
  superAdmin?: boolean;
  /** Only present when role === "rider". */
  rider?: { plate?: string; vehicleType?: string; active: boolean };
};

export type RiderAccountDTO = {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  plate?: string;
  vehicleType?: string;
  active: boolean;
  activeJobs: number;
  completedJobs: number;
  lastLoginAt: string | null;
  createdAt: string | null;
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
  /** Units the operator runs. 0 = unlimited. */
  fleetSize: number;
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
    /** Units still free for booking. `null` = unlimited (no fleet cap set). */
    unitsAvailable: number | null;
    /** True when every unit of this class is on an active delivery. */
    soldOut: boolean;
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
  changedByRole: "system" | "customer" | "admin" | "rider";
  at: string;
};

export type HandoverStatusDTO = {
  pickupUsedAt?: string;
  pickupLocked: boolean;
  deliveryUsedAt?: string;
  deliveryLocked: boolean;
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
  assignedDriver?: { name?: string; phone?: string; plate?: string };
  assignedRiderId?: string;
  handover?: HandoverStatusDTO;
  /** The sender's pickup code — only ever included for the booking's own owner. */
  pickupCode?: string;
  /** Relative link to the receiver's public tracking page (`/track/<token>`) — so the
   *  sender can forward it manually. Only ever included for the booking's own owner. */
  trackingUrl?: string;
  statusHistory: BookingStatusEntryDTO[];
  createdAt: string;
  updatedAt: string;
  customer?: { id: string; fullName: string; email: string; phone: string };
};

/** Public, no-login payload for the receiver's tracking page (GET /api/track/:token). */
export type TrackingDTO = {
  bookingReference: string;
  status: BookingStatus;
  recipientName: string;
  pickup: LocationDTO;
  destination: LocationDTO;
  vehicleName: string;
  scheduledDate: string;
  scheduledTime: string;
  rider?: { name?: string; phone?: string; plate?: string };
  statusHistory: Array<{ status: BookingStatus; at: string }>;
  /** The receiver's delivery code — shown until it's used. */
  deliveryCode?: string;
  deliveryUsedAt?: string;
  deliveryLocked: boolean;
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
