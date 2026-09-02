import { connectToDatabase } from "../db";
import { Booking, type BookingDoc, type BookingHydrated } from "../../models/Booking";
import { Vehicle } from "../../models/Vehicle";
import { StatusHistory } from "../../models/StatusHistory";
import { User } from "../../models/User";
import { ApiError } from "../api";
import { generateBookingReference } from "../utils";
import { calculatePrice } from "../pricing/engine";
import { computeRouteMetrics } from "./quote";
import { notify } from "../notifications";
import { BOOKING_STATUS_FLOW, type BookingStatus } from "../../config/booking";
import type { CreateBookingInput } from "../validation/booking";

/** Allowed status transitions (admin). "cancelled" is reachable from any non-terminal state. */
const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["driver_assigned", "cancelled"],
  driver_assigned: ["in_transit", "cancelled"],
  in_transit: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextStatuses(from: BookingStatus): BookingStatus[] {
  return TRANSITIONS[from] ?? [];
}

function combineDateTime(date: string, time: string): Date {
  return new Date(`${date}T${time}:00`);
}

/**
 * Create a booking. Route metrics and price are recomputed server-side —
 * the client-supplied vehicle slug and locations are the only trusted inputs.
 */
export async function createBooking(
  userId: string,
  input: CreateBookingInput,
): Promise<BookingHydrated> {
  await connectToDatabase();

  const scheduledAt = combineDateTime(input.scheduledDate, input.scheduledTime);
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new ApiError("Invalid delivery date or time.", 422);
  }
  if (scheduledAt.getTime() < Date.now() - 5 * 60 * 1000) {
    throw new ApiError("Delivery date/time cannot be in the past.", 422);
  }

  const vehicle = await Vehicle.findOne({ slug: input.vehicleSlug, active: true });
  if (!vehicle) throw new ApiError("The selected vehicle is not available.", 422);

  const metrics = await computeRouteMetrics(input, { clientRoute: input.clientRoute });
  if (metrics.distanceKm <= 0) {
    throw new ApiError("We couldn't calculate a route for these locations.", 422);
  }

  const pricing = calculatePrice(
    {
      slug: vehicle.slug,
      name: vehicle.name,
      pricePerKm: vehicle.pricePerKm,
      basePrice: vehicle.basePrice,
      minimumFare: vehicle.minimumFare,
    },
    {
      distanceKm: metrics.distanceKm,
      returnLegKm: metrics.returnLegKm,
      stopCount: metrics.stopCount,
      estimatedDurationSeconds: metrics.estimatedDurationSeconds,
    },
  );

  const now = new Date();
  const reference = await uniqueReference();

  const booking = await Booking.create({
    bookingReference: reference,
    user: userId,
    pickup: input.pickup,
    stops: input.stops,
    destination: input.destination,
    deliveryType: input.deliveryType,
    scheduledDate: input.scheduledDate,
    scheduledTime: input.scheduledTime,
    scheduledAt,
    distanceKm: metrics.distanceKm,
    estimatedDurationSeconds: metrics.estimatedDurationSeconds,
    routePolyline: metrics.polyline,
    routeMeta: {
      distanceKm: metrics.distanceKm,
      returnLegKm: metrics.returnLegKm,
      estimatedDurationSeconds: metrics.estimatedDurationSeconds,
      source: metrics.source,
    },
    vehicle: {
      vehicleId: vehicle._id,
      slug: vehicle.slug,
      name: vehicle.name,
      image: vehicle.image,
      pricePerKm: vehicle.pricePerKm,
    },
    sender: input.sender,
    recipient: input.recipient,
    package: input.package,
    notes: input.notes,
    pricing: { ...pricing, computedAt: now },
    payment: { provider: "paystack", status: "unpaid", amount: pricing.total, currency: pricing.currency },
    status: "pending",
    statusHistory: [
      { status: "pending", note: "Booking created", changedByRole: "system", at: now },
    ],
  });

  await StatusHistory.create({
    booking: booking._id,
    bookingReference: reference,
    toStatus: "pending",
    note: "Booking created",
    actorRole: "system",
    at: now,
  });

  await notify.bookingCreated(userId, booking, {
    email: input.sender.email || undefined,
    phone: input.sender.phone,
  });

  return booking;
}

async function uniqueReference(): Promise<string> {
  for (let i = 0; i < 6; i += 1) {
    const ref = generateBookingReference();
    const clash = await Booking.exists({ bookingReference: ref });
    if (!clash) return ref;
  }
  return `${generateBookingReference()}${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

/**
 * Change a booking's status (admin). Records history in both the embedded log
 * and the StatusHistory collection, and fires a customer notification.
 */
export async function changeBookingStatus(params: {
  bookingId: string;
  to: BookingStatus;
  note?: string;
  actorRole: "admin" | "system" | "customer";
  actorId?: string;
  driver?: { name?: string; phone?: string };
  force?: boolean;
}): Promise<BookingHydrated> {
  await connectToDatabase();
  const booking = await Booking.findById(params.bookingId);
  if (!booking) throw new ApiError("Booking not found.", 404);

  const from = booking.status as BookingStatus;
  const to = params.to;

  if (from === to) throw new ApiError(`Booking is already ${to}.`, 409);
  if (!params.force && !canTransition(from, to)) {
    throw new ApiError(`Cannot move a ${from} booking to ${to}.`, 409);
  }

  const now = new Date();
  booking.status = to;
  booking.statusHistory.push({
    status: to,
    note: params.note,
    changedByRole: params.actorRole,
    changedBy: params.actorId as unknown as BookingDoc["statusHistory"][number]["changedBy"],
    at: now,
  });

  if (params.driver && (params.driver.name || params.driver.phone)) {
    booking.assignedDriver = { name: params.driver.name, phone: params.driver.phone };
  }
  if (to === "confirmed" && !booking.confirmedAt) booking.confirmedAt = now;
  if (to === "delivered") booking.deliveredAt = now;
  if (to === "cancelled") booking.cancelledReason = params.note;
  if (to === "confirmed" && booking.payment?.status === "unpaid") {
    booking.payment.status = "pending";
  }

  await booking.save();

  let actorName: string | undefined;
  if (params.actorId) {
    const u = await User.findById(params.actorId).lean();
    if (u) actorName = `${u.firstName} ${u.lastName}`.trim();
  }

  await StatusHistory.create({
    booking: booking._id,
    bookingReference: booking.bookingReference,
    fromStatus: from,
    toStatus: to,
    note: params.note,
    actorRole: params.actorRole,
    actor: params.actorId,
    actorName,
    at: now,
  });

  await notify.statusChanged(String(booking.user), booking, to);

  return booking;
}

export function progressIndex(status: BookingStatus): number {
  if (status === "cancelled") return -1;
  return BOOKING_STATUS_FLOW.indexOf(status);
}
