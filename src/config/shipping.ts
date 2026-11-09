/**
 * Interstate / international shipping (Terminal Africa). Shared by client and server:
 * keep backend/src/config/shipping.ts and frontend/src/config/shipping.ts identical.
 */

export const SHIPMENT_STATUSES = [
  "pickup_fee_pending",
  "awaiting_pickup",
  "in_transit_to_office",
  "awaiting_dropoff",
  "received_at_office",
  "weight_confirmed",
  "quote_sent",
  "paid",
  "booked",
  "booking_failed",
  "in_transit",
  "delivery_attempted",
  "delivery_rejected",
  "delivered",
  "returned",
  "cancelled",
  "failed",
] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export type ShipmentTone = "neutral" | "info" | "progress" | "success" | "danger" | "warning";

export const SHIPMENT_STATUS_META: Record<
  ShipmentStatus,
  { label: string; description: string; tone: ShipmentTone }
> = {
  pickup_fee_pending: {
    label: "Pickup fee due",
    description: "Pay the pickup fee so a rider can collect your package and bring it to our office.",
    tone: "warning",
  },
  awaiting_pickup: {
    label: "Awaiting pickup",
    description: "Pickup fee received. A rider is on the way to collect your package.",
    tone: "progress",
  },
  in_transit_to_office: {
    label: "On the way to our office",
    description: "Your package has been collected and is heading to our office.",
    tone: "progress",
  },
  awaiting_dropoff: {
    label: "Awaiting drop-off",
    description: "Bring your package to our office and show your shipment reference.",
    tone: "neutral",
  },
  received_at_office: {
    label: "Received at office",
    description: "We have your package and will weigh and measure it next.",
    tone: "info",
  },
  weight_confirmed: {
    label: "Weighed and measured",
    description: "Your package has been weighed. We are preparing your delivery options.",
    tone: "info",
  },
  quote_sent: {
    label: "Quote ready",
    description: "Review your delivery options and pay to ship.",
    tone: "warning",
  },
  paid: {
    label: "Paid",
    description: "Payment received. We are booking your shipment with the carrier.",
    tone: "info",
  },
  booked: {
    label: "Booked with carrier",
    description: "Your shipment is booked and will be collected by the carrier.",
    tone: "success",
  },
  booking_failed: {
    label: "Booking being retried",
    description: "Your payment is safe. We hit a problem booking with the carrier and our team is on it.",
    tone: "warning",
  },
  in_transit: {
    label: "In transit",
    description: "Your shipment is on its way to the destination.",
    tone: "progress",
  },
  delivery_attempted: {
    label: "Delivery attempted",
    description: "The driver tried to deliver your package but could not complete the delivery. We will be in touch to arrange another attempt.",
    tone: "warning",
  },
  delivery_rejected: {
    label: "Delivery rejected",
    description: "The package was not accepted by the receiver. We will contact you about what happens next.",
    tone: "danger",
  },
  delivered: {
    label: "Delivered",
    description: "Your shipment has been delivered.",
    tone: "success",
  },
  returned: {
    label: "Package returned",
    description: "The package could not be delivered and has been returned to the sender.",
    tone: "danger",
  },
  cancelled: { label: "Cancelled", description: "This shipment was cancelled.", tone: "danger" },
  failed: {
    label: "Delivery issue",
    description: "The carrier reported a problem with this shipment. Our team will contact you.",
    tone: "danger",
  },
};

/**
 * Interstate shipments are run by hand (no carrier service): the office sets the price and assigns a driver, so a few
 * steps read differently. Anything not listed here reads the same as in SHIPMENT_STATUS_META.
 */
export const SHIPMENT_STATUS_META_HAND_RUN: Partial<Record<ShipmentStatus, { label: string; description: string }>> = {
  weight_confirmed: { label: "Weighed and measured", description: "Your package has been weighed. We are working out your price." },
  quote_sent: { label: "Price ready", description: "Our price for your shipment is ready. Review it and pay to ship." },
  paid: { label: "Paid", description: "Payment received. We are arranging a driver for your shipment." },
  booked: { label: "Driver assigned", description: "A driver has your shipment. Their number is on this page." },
  in_transit: { label: "On the way", description: "Your shipment is on its way to the destination." },
  failed: { label: "Delivery issue", description: "There is a problem with this delivery. Our team will contact you." },
};

/** The label, description and tone of a status, worded for the kind of shipment. */
export function shipmentStatusMeta(status: ShipmentStatus, shipmentType?: string) {
  const base = SHIPMENT_STATUS_META[status];
  const hand = shipmentType === "interstate" ? SHIPMENT_STATUS_META_HAND_RUN[status] : undefined;
  return hand ? { ...base, ...hand } : base;
}

/**
 * Where a shipment on its way can go next, when the office moves it by hand. A delivery that is attempted or rejected is not
 * the end: it can go out again, or the package is returned to the sender.
 */
export const DELIVERY_MOVES: Partial<Record<ShipmentStatus, ShipmentStatus[]>> = {
  booked: ["in_transit", "delivery_attempted", "delivery_rejected", "delivered"],
  in_transit: ["delivery_attempted", "delivery_rejected", "delivered", "returned"],
  delivery_attempted: ["in_transit", "delivery_rejected", "delivered", "returned"],
  delivery_rejected: ["in_transit", "returned"],
};

/** Delivery problems: the customer is told why, so the office must say why. */
export const DELIVERY_PROBLEM_STATUSES: ShipmentStatus[] = ["delivery_attempted", "delivery_rejected", "returned"];

/** The happy path for each handover method, used to draw the timeline. */
export const SHIPMENT_FLOW_PICKUP: ShipmentStatus[] = [
  "pickup_fee_pending",
  "awaiting_pickup",
  "in_transit_to_office",
  "received_at_office",
  "weight_confirmed",
  "quote_sent",
  "paid",
  "booked",
  "in_transit",
  "delivered",
];

export const SHIPMENT_FLOW_DROPOFF: ShipmentStatus[] = [
  "awaiting_dropoff",
  "received_at_office",
  "weight_confirmed",
  "quote_sent",
  "paid",
  "booked",
  "in_transit",
  "delivered",
];

/** A sender outside Nigeria: nothing passes through our office, the carrier collects from the sender. */
export const SHIPMENT_FLOW_CARRIER: ShipmentStatus[] = ["quote_sent", "paid", "booked", "in_transit", "delivered"];

/**
 * The two kinds of international shipment.
 *  export: from Nigeria to any country. The parcel goes through our Lagos office (drop-off or our rider).
 *  global: between any two countries. No office stop: the carrier collects from the sender and delivers to the receiver.
 */
export const SHIPMENT_FLOWS = ["export", "global"] as const;
export type ShipmentFlow = (typeof SHIPMENT_FLOWS)[number];
export const EXPORT_COUNTRY = "NG";
export const SHIPMENT_FLOW_LABEL: Record<ShipmentFlow, string> = { export: "Export from Nigeria", global: "Global" };

/** The currencies Terminal accepts on a parcel item and for rates. */
export const ITEM_CURRENCIES = ["NGN", "USD", "GBP", "EUR", "CAD", "AUD", "AED", "CNY", "GHS", "HKD", "KES", "TZS", "UGX", "ZAR"] as const;

/** Over this weight (after rounding up) the Office Admin must enter a quote by hand. */
export const MAX_AUTO_QUOTE_KG = 70;

export type MarkupTier = { minKg: number; maxKg: number; percent: number };

/** AJCL markup on the carrier's base rate, by billed weight. Editable by the Super Admin. */
export const DEFAULT_MARKUP_TIERS: MarkupTier[] = [
  { minKg: 1, maxKg: 12, percent: 5.8 },
  { minKg: 13, maxKg: 24, percent: 3.5 },
  { minKg: 25, maxKg: 40, percent: 3 },
  { minKg: 41, maxKg: 50, percent: 2.5 },
  { minKg: 51, maxKg: 70, percent: 2.5 },
];

export const DEFAULT_FLAT_FEE_NGN = 3500;
export const DEFAULT_SURCHARGE_NGN = 5000;
export const DEFAULT_WALLET_ALERT_NGN = 50000;

export const DEFAULT_DISCLAIMER = [
  "All official transactions and dealings should be conducted through our authorised channels and within our company premises.",
  "The Company shall not be held liable for any loss, damage, fraud, or dispute arising from transactions or dealings conducted outside our authorised premises or channels.",
  "Please deal only with authorised representatives of the Company.",
];

export const DEFAULT_DUTIES_NOTICE =
  "Duties, import taxes and any other charges at the destination are the receiver's responsibility.";

export const DEFAULT_REFUND_POLICY =
  "The pickup fee covers the rider's trip to collect your package and is paid before the rider is assigned. It is non-refundable once a rider has been assigned. If we cancel before a rider is assigned, or we are unable to collect your package, contact support and we will review a refund.";

export const SHIPMENT_TYPES = ["interstate", "international"] as const;
export type ShipmentType = (typeof SHIPMENT_TYPES)[number];
