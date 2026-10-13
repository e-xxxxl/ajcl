/** Booking flow constants shared by client and server. */

export const DELIVERY_TYPES = {
  single: {
    value: "single",
    label: "Single Delivery",
    description: "Pickup → stops → destination. One-way trip.",
  },
  return: {
    value: "return",
    label: "Return Delivery",
    description:
      "Pickup → stops → destination → back to pickup. The rider waits and returns. Priced for the full round trip.",
  },
} as const;

export type DeliveryType = keyof typeof DELIVERY_TYPES;

export const MAX_STOPS = 5;

export const BOOKING_STATUS = {
  pending: "pending",
  confirmed: "confirmed",
  driver_assigned: "driver_assigned",
  in_transit: "in_transit",
  delivered: "delivered",
  cancelled: "cancelled",
  returned: "returned",
} as const;

export type BookingStatus = (typeof BOOKING_STATUS)[keyof typeof BOOKING_STATUS];

/** Ordered lifecycle used to render the tracking timeline. "cancelled" is terminal and off-track. */
export const BOOKING_STATUS_FLOW: BookingStatus[] = [
  "pending",
  "confirmed",
  "driver_assigned",
  "in_transit",
  "delivered",
];

export const BOOKING_STATUS_META: Record<
  BookingStatus,
  {
    label: string;
    description: string;
    tone: "neutral" | "info" | "progress" | "success" | "danger" | "warning";
  }
> = {
  pending: {
    label: "Pending",
    description: "Booking created. Awaiting payment / confirmation.",
    tone: "neutral",
  },
  confirmed: {
    label: "Confirmed",
    description: "Payment received. Your booking is confirmed.",
    tone: "info",
  },
  driver_assigned: {
    label: "Driver Assigned",
    description: "A rider has been assigned and is heading to pickup.",
    tone: "progress",
  },
  in_transit: {
    label: "In Transit",
    description: "Package picked up and on the way.",
    tone: "progress",
  },
  delivered: {
    label: "Delivered",
    description: "Package delivered successfully.",
    tone: "success",
  },
  cancelled: {
    label: "Cancelled",
    description: "This booking was cancelled.",
    tone: "danger",
  },
  returned: {
    label: "Returned",
    description: "The package could not be delivered and was returned.",
    tone: "warning",
  },
};

/** Why an order came back. Chosen by the admin when marking it returned. */
export const RETURN_REASONS = [
  { value: "recipient_unavailable", label: "Recipient unavailable" },
  { value: "recipient_refused", label: "Recipient refused the package" },
  { value: "wrong_address", label: "Wrong or incomplete address" },
  { value: "damaged_package", label: "Package damaged" },
  { value: "other", label: "Other" },
] as const;

export type ReturnReason = (typeof RETURN_REASONS)[number]["value"];

export function returnReasonLabel(value?: string | null): string {
  return RETURN_REASONS.find((r) => r.value === value)?.label ?? "Not given";
}

export const PAYMENT_STATUS = {
  unpaid: "unpaid",
  pending: "pending",
  paid: "paid",
  failed: "failed",
  refunded: "refunded",
  /** Partner orders: billed to the partner's account and settled later. */
  on_account: "on_account",
} as const;

export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

/** An order is "funded" when it has been paid for or is billed to a partner account. */
export function isFundedPayment(status?: string | null): boolean {
  return status === "paid" || status === "on_account";
}

export const PACKAGE_CATEGORIES = [
  "Documents",
  "Food & Perishables",
  "Electronics",
  "Clothing & Fabrics",
  "Fragile / Glassware",
  "Furniture & Appliances",
  "Auto Parts",
  "Medical Supplies",
  "Other",
] as const;

export const BOOKING_STEPS = [
  { key: "locations", label: "Locations" },
  { key: "vehicle", label: "Vehicle" },
  { key: "details", label: "Delivery Details" },
  { key: "review", label: "Review" },
  { key: "payment", label: "Payment" },
] as const;

export type BookingStepKey = (typeof BOOKING_STEPS)[number]["key"];
