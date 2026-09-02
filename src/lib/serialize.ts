import type { BookingDoc } from "../models/Booking";
import type { VehicleDoc } from "../models/Vehicle";
import type { NotificationDoc } from "../models/Notification";
import type { BookingDTO, NotificationDTO, VehicleDTO } from "../types";

type Lean<T> = T & { _id: unknown; createdAt?: Date; updatedAt?: Date };

const id = (v: unknown) => String(v);
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined);

export function serializeVehicle(v: Lean<VehicleDoc>): VehicleDTO {
  return {
    id: id(v._id),
    slug: v.slug,
    name: v.name,
    description: v.description,
    image: v.image ?? "",
    capacity: v.capacity ?? "",
    pricePerKm: v.pricePerKm,
    basePrice: v.basePrice,
    minimumFare: v.minimumFare,
    averageSpeedKmh: v.averageSpeedKmh,
    active: v.active,
    sortOrder: v.sortOrder ?? 0,
  };
}

type PopulatedUser = { _id: unknown; firstName: string; lastName: string; email: string; phone: string };

export function serializeBooking(
  b: Lean<BookingDoc> & { user?: PopulatedUser | unknown },
  opts: { includeCustomer?: boolean } = {},
): BookingDTO {
  const loc = (l: BookingDoc["pickup"]) =>
    l
      ? {
          formattedAddress: l.formattedAddress,
          lat: l.lat ?? undefined,
          lng: l.lng ?? undefined,
          placeId: l.placeId ?? undefined,
          label: l.label ?? undefined,
          manual: l.manual ?? undefined,
        }
      : { formattedAddress: "" };

  const user = b.user as unknown as PopulatedUser | undefined;
  const dto: BookingDTO = {
    id: id(b._id),
    bookingReference: b.bookingReference,
    status: b.status as BookingDTO["status"],
    deliveryType: b.deliveryType as BookingDTO["deliveryType"],
    pickup: loc(b.pickup),
    stops: (b.stops ?? []).map(loc),
    destination: loc(b.destination),
    scheduledDate: b.scheduledDate,
    scheduledTime: b.scheduledTime,
    scheduledAt: iso(b.scheduledAt) ?? "",
    distanceKm: b.distanceKm ?? 0,
    estimatedDurationSeconds: b.estimatedDurationSeconds ?? 0,
    routePolyline: b.routePolyline ?? undefined,
    vehicle: {
      vehicleId: id(b.vehicle?.vehicleId),
      slug: b.vehicle?.slug ?? "",
      name: b.vehicle?.name ?? "",
      image: b.vehicle?.image ?? undefined,
      pricePerKm: b.vehicle?.pricePerKm ?? 0,
    },
    sender: { name: b.sender?.name ?? "", phone: b.sender?.phone ?? "", email: b.sender?.email ?? undefined },
    recipient: {
      name: b.recipient?.name ?? "",
      phone: b.recipient?.phone ?? "",
      email: b.recipient?.email ?? undefined,
    },
    package: {
      description: b.package?.description ?? "",
      category: b.package?.category ?? "Other",
      quantity: b.package?.quantity ?? 1,
      declaredValue: b.package?.declaredValue ?? 0,
      specialInstructions: b.package?.specialInstructions ?? undefined,
    },
    notes: b.notes ?? undefined,
    pricing: {
      distanceKm: b.pricing?.distanceKm ?? 0,
      billableDistanceKm: b.pricing?.billableDistanceKm ?? 0,
      estimatedDurationSeconds: b.pricing?.estimatedDurationSeconds ?? 0,
      pricePerKm: b.pricing?.pricePerKm ?? 0,
      basePrice: b.pricing?.basePrice ?? 0,
      distanceCharge: b.pricing?.distanceCharge ?? 0,
      stopsFee: b.pricing?.stopsFee ?? 0,
      tax: b.pricing?.tax ?? 0,
      subtotal: b.pricing?.subtotal ?? 0,
      minimumFareApplied: b.pricing?.minimumFareApplied ?? false,
      total: b.pricing?.total ?? 0,
      currency: b.pricing?.currency ?? "NGN",
    },
    payment: {
      status: (b.payment?.status ?? "unpaid") as BookingDTO["payment"]["status"],
      reference: b.payment?.reference ?? undefined,
      authorizationUrl: b.payment?.authorizationUrl ?? undefined,
      amount: b.payment?.amount ?? undefined,
      currency: b.payment?.currency ?? "NGN",
      channel: b.payment?.channel ?? undefined,
      paidAt: iso(b.payment?.paidAt),
    },
    assignedDriver: b.assignedDriver?.name
      ? { name: b.assignedDriver.name ?? undefined, phone: b.assignedDriver.phone ?? undefined }
      : undefined,
    statusHistory: (b.statusHistory ?? []).map((s) => ({
      status: s.status as BookingDTO["status"],
      note: s.note ?? undefined,
      changedByRole: (s.changedByRole ?? "system") as "system" | "customer" | "admin",
      at: iso(s.at) ?? "",
    })),
    createdAt: iso(b.createdAt) ?? "",
    updatedAt: iso(b.updatedAt) ?? "",
  };

  if (opts.includeCustomer && user && typeof user === "object" && "email" in user) {
    dto.customer = {
      id: id(user._id),
      fullName: `${user.firstName} ${user.lastName}`.trim(),
      email: user.email,
      phone: user.phone,
    };
  }

  return dto;
}

export function serializeNotification(n: Lean<NotificationDoc>): NotificationDTO {
  return {
    id: id(n._id),
    type: n.type,
    title: n.title,
    body: n.body,
    href: n.href ?? undefined,
    read: n.read,
    createdAt: iso(n.createdAt) ?? "",
  };
}
