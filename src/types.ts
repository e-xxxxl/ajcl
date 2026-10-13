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
  /** Present for partner accounts: orders are billed to the account instead of paid in the app. */
  partner?: { active: true; company?: string };
  /** Only present when role === "rider". */
  rider?: { plate?: string; vehicleType?: string; active: boolean; maxActiveJobs?: number };
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
  /** Effective limit: the rider's own setting, or the server default. */
  maxActiveJobs: number;
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
  /** House/flat number, floor, landmark, gate instructions. */
  details?: string;
  name?: string;
  area?: string;
  city?: string;
  state?: string;
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
  returnedAt?: string;
  returnReason?: string;
  returnNote?: string;
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


/** A booking as a rider sees it: addresses, contacts and package. No prices, payment or codes. */
export type RiderJobDTO = Omit<
  BookingDTO,
  "pricing" | "payment" | "customer" | "pickupCode" | "trackingUrl" | "vehicle"
> & {
  vehicle: { vehicleId: string; slug: string; name: string; image?: string };
};

export type RouteStopDTO = {
  jobRef: string;
  kind: "pickup" | "stop" | "dropoff" | "return";
  label: string;
  location: LocationDTO;
  /** Approx. road km from the previous stop (or the rider). null = unknown. */
  legKm: number | null;
  cumulativeKm: number;
  scheduledAt?: string;
};

export type RiderRouteDTO = {
  route: { stops: RouteStopDTO[]; totalKm: number; mapsUrl: string | null };
  /** Open orders that fit the rider's route (or sit near them, when they have no active jobs). */
  nearby: Array<{ job: RiderJobDTO; extraKm: number; mode: "on_route" | "near_you" }>;
  /** True when there is nothing to measure against: no active jobs and no location shared. */
  needsLocation: boolean;
  usedLocation: boolean;
  activeCount: number;
  maxActive: number;
  canAccept: boolean;
  maxDetourKm: number;
};



export type PartnerPaymentDTO = {
  id: string;
  amount: number;
  method: "transfer" | "cash" | "cheque" | "other";
  reference?: string;
  note?: string;
  receivedAt: string;
  recordedByName?: string;
};

export type PartnerLedgerOrderDTO = {
  reference: string;
  createdAt: string;
  status: BookingStatus;
  total: number;
  /** How much of this order the recorded payments have covered (oldest orders first). */
  allocated: number;
  settled: boolean;
  pickup: string;
  destination: string;
};

/** A partner's account: what they've been billed, what they've paid, what they still owe. */
export type PartnerLedgerDTO = {
  billed: number;
  paid: number;
  outstanding: number;
  /** Overpayment, if the partner has paid more than they've been billed. */
  credit: number;
  creditLimit: number | null;
  /** Room left under the credit limit (null when there is no limit). */
  availableCredit: number | null;
  orders: PartnerLedgerOrderDTO[];
  payments: PartnerPaymentDTO[];
};

/** A partner as the admin sees them. */
export type PartnerAccountDTO = {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  active: boolean;
  company?: string;
  markupPercent: number;
  creditLimit: number | null;
  notes?: string;
  since?: string;
  billed: number;
  paid: number;
  outstanding: number;
  orderCount: number;
};

/** Evidence a rider captured at pickup or delivery. Location is for admins only. */
export type ProofDTO = {
  id: string;
  stage: "pickup" | "delivery";
  riderName?: string;
  /** When the rider's device captured the fix. */
  takenAt: string;
  photoIds: string[];
  location?: {
    lat: number;
    lng: number;
    accuracyM?: number;
    /** Metres from the booked address. */
    distanceFromTargetM?: number;
    /** True when the rider was well outside the radius around the booked address. */
    flagged: boolean;
  };
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
