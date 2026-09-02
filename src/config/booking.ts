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
  { label: string; description: string; tone: "neutral" | "info" | "progress" | "success" | "danger" }
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
};

export const PAYMENT_STATUS = {
  unpaid: "unpaid",
  pending: "pending",
  paid: "paid",
  failed: "failed",
  refunded: "refunded",
} as const;

export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

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
