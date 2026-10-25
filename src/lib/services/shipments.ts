import { connectToDatabase } from "../db";
import { Shipment, type ShipmentDoc, type ShipmentHydrated } from "../../models/Shipment";
import { Booking, type BookingHydrated } from "../../models/Booking";
import { User } from "../../models/User";
import { ApiError } from "../api";
import { createBooking, changeBookingStatus } from "./booking";
import { getShippingSettings } from "./shipping-settings";
import { resolveLocation } from "./locations";
import { publicCarrierName, publicText, publicTrackingUrl, publicHistoryNote } from "../public-text";
import { billedWeightKg, needsManualQuote } from "./shipment-pricing";
import { notifyCustomer, notifyOffice } from "./shipment-notify";
import type { CreateShipmentInput } from "../validation/shipment";
import type { ShipmentStatus } from "../../config/shipping";

/**
 * Shipment lifecycle for interstate / international parcels. Local deliveries never touch
 * this file: a shipment's pickup leg is an ordinary Booking (kind "shipment_pickup") that
 * rides the existing Rider's App, payment and auto-assignment, and reports back here.
 */

export type Actor = {
  id?: string;
  name: string;
  role: "customer" | "admin" | "office_admin" | "system" | "carrier";
};

export const SYSTEM: Actor = { name: "System", role: "system" };

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : undefined);

const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export async function uniqueReference(): Promise<string> {
  for (let i = 0; i < 8; i += 1) {
    let code = "";
    for (let j = 0; j < 6; j += 1) code += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
    const ref = `AJX-${code}`;
    if (!(await Shipment.exists({ reference: ref }))) return ref;
  }
  return `AJX-${Date.now().toString(36).toUpperCase().slice(-8)}`;
}

/** Record a status change in the shipment's history. Does not save. */
export function setStatus(shipment: ShipmentHydrated, status: ShipmentStatus, actor: Actor, note?: string) {
  shipment.status = status;
  shipment.statusHistory.push({
    status,
    note,
    byRole: actor.role,
    byName: actor.name,
    at: new Date(),
  });
}

export async function findShipmentByReference(reference: string): Promise<ShipmentHydrated> {
  await connectToDatabase();
  const shipment = await Shipment.findOne({ reference: reference.trim().toUpperCase() });
  if (!shipment) throw new ApiError("Shipment not found.", 404);
  return shipment;
}

export async function findOwnShipment(userId: string, reference: string): Promise<ShipmentHydrated> {
  const shipment = await findShipmentByReference(reference);
  if (String(shipment.user) !== userId) throw new ApiError("Shipment not found.", 404);
  return shipment;
}

/** Where the Rider's App takes a pickup parcel, and where drop-offs are made. */
export function officeAddressLine(office: {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}) {
  return [office.line1, office.line2, office.city, office.state, office.zip].filter(Boolean).join(", ");
}

/* ── Creating a shipment ───────────────────────────────────────────────── */

export async function createShipmentRequest(userId: string, input: CreateShipmentInput): Promise<ShipmentHydrated> {
  await connectToDatabase();
  const settings = await getShippingSettings();
  const office = settings.office;

  // Use Terminal's own spelling of every place, and refuse ones it does not know.
  const from = await resolveLocation(input.sender, "sender");
  const to = await resolveLocation(input.receiver, "receiver");
  input = {
    ...input,
    sender: { ...input.sender, country: from.country, state: from.state, city: from.city },
    receiver: { ...input.receiver, country: to.country, state: to.state, city: to.city },
  };

  const items = input.parcel.items.length
    ? input.parcel.items
    : [
        {
          description: input.parcel.description.slice(0, 200),
          quantity: 1,
          value: input.parcel.declaredValue,
          hsCode: undefined,
        },
      ];

  const reference = await uniqueReference();
  const shipment = new Shipment({
    reference,
    shipmentType: input.shipmentType,
    user: userId,
    sender: input.sender,
    receiver: input.receiver,
    parcel: {
      description: input.parcel.description,
      estimatedWeightKg: input.parcel.estimatedWeightKg,
      dimensions: input.parcel.dimensions ?? {},
      declaredValue: input.parcel.declaredValue,
      items: items.map((i) => ({
        description: i.description,
        quantity: i.quantity,
        value: i.value,
        currency: "NGN",
        hsCode: i.hsCode || undefined,
      })),
    },
    handover: { method: input.handover.method },
    status: input.handover.method === "pickup" ? "pickup_fee_pending" : "awaiting_dropoff",
  });
  shipment.statusHistory.push({
    status: shipment.status,
    note: "Shipment created",
    byRole: "customer",
    byName: input.sender.name,
    at: new Date(),
  });

  let pickupBooking: BookingHydrated | null = null;
  if (input.handover.method === "pickup") {
    if (!office.line1 || !office.phone) {
      throw new ApiError("Rider pickup is not available right now. Please drop your package off at our office.", 503);
    }
    const p = input.handover.pickup;
    pickupBooking = await createBooking(
      userId,
      {
        pickup: p.location,
        stops: [],
        destination: {
          formattedAddress: officeAddressLine(office) || office.name || "AJ Courier & Logistics office",
          lat: office.lat ?? undefined,
          lng: office.lng ?? undefined,
          manual: office.lat == null || office.lng == null,
          name: office.name ?? undefined,
          city: office.city ?? undefined,
          state: office.state ?? undefined,
        },
        deliveryType: "single",
        scheduledDate: p.scheduledDate,
        scheduledTime: p.scheduledTime,
        vehicleSlug: p.vehicleSlug,
        // Recipient is our office desk. No email on purpose: the office code must reach staff only.
        sender: { name: input.sender.name, phone: input.sender.phone, email: input.sender.email || "" },
        recipient: { name: office.contactName || office.name || "AJCL office", phone: office.phone, email: "" },
        package: {
          description: `Shipment ${reference}: ${input.parcel.description}`.slice(0, 500),
          category: "Other",
          quantity: 1,
          declaredValue: input.parcel.declaredValue,
          specialInstructions: "",
        },
        notes: p.notes || "",
        clientRoute: p.clientRoute,
      },
      { shipment: { id: String(shipment._id), reference } },
    );
    shipment.handover.pickupBooking = pickupBooking._id as unknown as typeof shipment.handover.pickupBooking;
  }

  try {
    await shipment.save();
  } catch (err) {
    if (pickupBooking) {
      await changeBookingStatus({
        bookingId: String(pickupBooking._id),
        to: "cancelled",
        note: "Shipment could not be created",
        actorRole: "system",
      }).catch(() => undefined);
    }
    throw err;
  }

  await notifyCustomer(
    userId,
    "shipment_created",
    "Shipment created",
    input.handover.method === "pickup"
      ? `Shipment ${reference} is created. Pay the pickup fee so a rider can collect your package.`
      : `Shipment ${reference} is created. Bring your package to our office and quote this reference.`,
    reference,
  );
  if (input.handover.method === "dropoff") {
    await notifyOffice("admin_shipment_new", "New shipment to expect", `${reference} will be dropped off at the office.`, reference);
  }
  return shipment;
}

/* ── Pickup leg callbacks ──────────────────────────────────────────────── */

/** The pickup fee is paid and the order is confirmed: the rider is on the way. */
export async function onPickupFunded(booking: BookingHydrated): Promise<void> {
  const shipment = booking.shipment ? await Shipment.findById(booking.shipment) : null;
  if (!shipment || shipment.status !== "pickup_fee_pending") return;
  setStatus(shipment, "awaiting_pickup", SYSTEM, "Pickup fee received");
  await shipment.save();
  await notifyCustomer(
    String(shipment.user),
    "shipment_created",
    "Pickup fee received",
    `Thanks. A rider is being assigned to collect shipment ${shipment.reference}.`,
    shipment.reference,
  );
  await notifyOffice(
    "admin_shipment_new",
    "Shipment on the way to the office",
    `${shipment.reference} has a rider pickup booked. Confirm it when it arrives.`,
    shipment.reference,
  );
}

/** Keep a shipment in step with the status of its rider pickup booking. */
export async function syncShipmentFromPickup(booking: BookingHydrated, to: string): Promise<void> {
  await connectToDatabase();
  const shipment = booking.shipment ? await Shipment.findById(booking.shipment) : null;
  if (!shipment) return;

  if (to === "in_transit" && shipment.status === "awaiting_pickup") {
    setStatus(shipment, "in_transit_to_office", SYSTEM, "Collected by the rider");
    await shipment.save();
    await notifyCustomer(
      String(shipment.user),
      "shipment_created",
      "Package collected",
      `Your package for shipment ${shipment.reference} is on its way to our office.`,
      shipment.reference,
    );
  } else if (to === "delivered" && ["awaiting_pickup", "in_transit_to_office"].includes(shipment.status)) {
    // The rider has handed it over. Staff still confirm receipt themselves (and are logged doing so).
    await notifyOffice(
      "admin_shipment_new",
      "Rider has arrived",
      `The rider delivered ${shipment.reference}. Confirm receipt after checking the parcel.`,
      shipment.reference,
    );
  } else if (to === "cancelled" && ["pickup_fee_pending", "awaiting_pickup"].includes(shipment.status)) {
    setStatus(shipment, "cancelled", SYSTEM, "The pickup booking was cancelled");
    await shipment.save();
    await notifyCustomer(String(shipment.user), "shipment_failed", "Shipment cancelled", `Shipment ${shipment.reference} was cancelled.`, shipment.reference);
  }
}

/* ── Cancelling ────────────────────────────────────────────────────────── */

/** Before the parcel is weighed. International customers may pay for shipping in these. */
export const PREPAY_STATUSES: ShipmentStatus[] = ["pickup_fee_pending", "awaiting_pickup", "in_transit_to_office", "awaiting_dropoff", "received_at_office"];

const CUSTOMER_CANCELLABLE: ShipmentStatus[] = ["pickup_fee_pending", "awaiting_dropoff", "weight_confirmed", "quote_sent"];
const ADMIN_CANCELLABLE: ShipmentStatus[] = [
  "pickup_fee_pending",
  "awaiting_pickup",
  "in_transit_to_office",
  "awaiting_dropoff",
  "received_at_office",
  "weight_confirmed",
  "quote_sent",
  "paid",
  "booking_failed",
];

export async function cancelShipment(shipment: ShipmentHydrated, actor: Actor, reason?: string): Promise<ShipmentHydrated> {
  const allowed = actor.role === "customer" ? CUSTOMER_CANCELLABLE : ADMIN_CANCELLABLE;
  if (!allowed.includes(shipment.status as ShipmentStatus)) {
    throw new ApiError(
      actor.role === "customer"
        ? "This shipment can no longer be cancelled online. Please contact support."
        : `A ${shipment.status.replace(/_/g, " ")} shipment cannot be cancelled here.`,
      409,
    );
  }

  if (actor.role === "customer" && shipment.shippingPaidAt) {
    throw new ApiError("You have already paid for shipping. Please contact support to cancel and arrange a refund.", 409);
  }

  const bookingId = shipment.handover.pickupBooking;
  if (bookingId) {
    const booking = await Booking.findById(bookingId);
    if (booking && ["pending", "confirmed"].includes(booking.status)) {
      await changeBookingStatus({
        bookingId: String(booking._id),
        to: "cancelled",
        note: reason || "Shipment cancelled",
        actorRole: actor.role === "customer" ? "customer" : "admin",
        actorId: actor.id,
      }).catch((err) => console.error("[shipments] could not cancel the pickup booking", err));
    }
  }

  shipment.cancelledReason = reason;
  setStatus(shipment, "cancelled", actor, reason);
  await shipment.save();
  if (actor.role !== "customer") {
    await notifyCustomer(String(shipment.user), "shipment_failed", "Shipment cancelled", `Shipment ${shipment.reference} was cancelled${reason ? `: ${reason}` : "."}`, shipment.reference);
  } else {
    await notifyOffice("admin_shipment_new", "Shipment cancelled by customer", `${shipment.reference} was cancelled.`, shipment.reference);
  }
  return shipment;
}

/* ── Office desk ───────────────────────────────────────────────────────── */

const RECEIVABLE: ShipmentStatus[] = ["awaiting_dropoff", "awaiting_pickup", "in_transit_to_office"];

export async function receiveAtOffice(shipment: ShipmentHydrated, actor: Actor, note?: string): Promise<ShipmentHydrated> {
  if (!RECEIVABLE.includes(shipment.status as ShipmentStatus)) {
    throw new ApiError(
      shipment.status === "pickup_fee_pending"
        ? "The customer has not paid the pickup fee yet."
        : "This shipment is not waiting to be received.",
      409,
    );
  }
  shipment.handover.receivedAt = new Date();
  shipment.handover.receivedBy = actor.id as unknown as typeof shipment.handover.receivedBy;
  shipment.handover.receivedByName = actor.name;
  setStatus(shipment, "received_at_office", actor, note || "Received at the office");
  await shipment.save();

  await notifyCustomer(
    String(shipment.user),
    "shipment_received",
    "We have your package",
    `Shipment ${shipment.reference} has arrived at our office. We will weigh it and send your delivery options.`,
    shipment.reference,
  );
  return shipment;
}

/** The pickup booking's delivery code, for the office to give the rider. Each view is logged. */
export async function viewOfficeCode(shipment: ShipmentHydrated, actor: Actor): Promise<{ code: string | null; used: boolean }> {
  const bookingId = shipment.handover.pickupBooking;
  if (!bookingId) return { code: null, used: false };
  const booking = await Booking.findById(bookingId).select("+handover.deliveryCode status handover.deliveryCodeUsedAt").lean();
  const code = booking?.handover?.deliveryCode ?? null;
  if (code) {
    shipment.handover.officeCodeViews.push({
      by: actor.id as unknown as never,
      byName: actor.name,
      at: new Date(),
    } as never);
    await shipment.save();
  }
  return { code, used: Boolean(booking?.handover?.deliveryCodeUsedAt) };
}

const WEIGHABLE: ShipmentStatus[] = ["received_at_office", "weight_confirmed", "quote_sent"];

export async function confirmWeight(
  shipment: ShipmentHydrated,
  actor: Actor,
  input: { weightKg: number; dimensions?: { lengthCm?: number; widthCm?: number; heightCm?: number }; note?: string },
): Promise<ShipmentHydrated> {
  if (!WEIGHABLE.includes(shipment.status as ShipmentStatus)) {
    throw new ApiError("Confirm that the package has arrived before weighing it.", 409);
  }
  const billed = billedWeightKg(input.weightKg);
  const changed = shipment.confirmed?.weightKg !== input.weightKg;

  shipment.confirmed = {
    weightKg: input.weightKg,
    dimensions: input.dimensions ?? {},
    note: input.note,
    by: actor.id as unknown as never,
    byName: actor.name,
    at: new Date(),
  } as never;
  shipment.quote.billedWeightKg = billed;

  // A new weight invalidates any earlier carrier options and Terminal draft.
  if (changed) {
    shipment.quote.options = [] as never;
    shipment.quote.selectedRateId = undefined;
    shipment.quote.sentAt = undefined;
    shipment.terminal.packagingId = undefined;
    shipment.terminal.parcelId = undefined;
    shipment.terminal.shipmentId = undefined;
  }
  if (shipment.status !== "weight_confirmed") {
    setStatus(shipment, "weight_confirmed", actor, `Weighed at ${input.weightKg} kg (billed as ${billed} kg)`);
  }
  await shipment.save();
  return shipment;
}

export function requiresManualQuote(shipment: ShipmentHydrated): boolean {
  const billed = shipment.quote.billedWeightKg ?? billedWeightKg(shipment.confirmed?.weightKg ?? shipment.parcel.estimatedWeightKg);
  return needsManualQuote(billed);
}

/* ── Serialising ───────────────────────────────────────────────────────── */

type DimensionsDTO = { lengthCm?: number; widthCm?: number; heightCm?: number };
const dimsOf = (d?: { lengthCm?: number | null; widthCm?: number | null; heightCm?: number | null } | null): DimensionsDTO => ({
  lengthCm: d?.lengthCm ?? undefined,
  widthCm: d?.widthCm ?? undefined,
  heightCm: d?.heightCm ?? undefined,
});

export type QuoteOptionDTO = {
  rateId: string;
  carrierName: string;
  carrierLogo?: string;
  service?: string;
  deliveryTime?: string;
  sourceAmount: number;
  sourceCurrency: string;
  fxRate: number;
  fxRateUpdatedAt?: string;
  baseRate: number;
  tierPercent: number;
  markup: number;
  flatFee: number;
  surcharge: number;
  total: number;
  manual: boolean;
};

export type RefundDTO = { amount: number; reason: string; reference?: string; markedAt?: string; byName?: string };

export type ShipmentDTO = {
  id: string;
  reference: string;
  shipmentType: "interstate" | "international";
  status: ShipmentStatus;
  createdAt?: string;
  updatedAt?: string;
  customer?: { name: string; email: string; phone: string };
  sender: ShipmentDoc["sender"];
  receiver: ShipmentDoc["receiver"];
  parcel: {
    description: string;
    estimatedWeightKg: number;
    dimensions: DimensionsDTO;
    declaredValue: number;
    items: { description: string; quantity: number; value: number; currency: string; hsCode?: string }[];
  };
  handover: {
    method: "pickup" | "dropoff";
    pickupBookingReference?: string;
    pickupFee?: { amount: number; paid: boolean; status: string; bookingStatus: string };
    receivedAt?: string;
    receivedByName?: string;
    officeCodeViews?: { byName: string; at: string }[];
  };
  confirmed?: { weightKg: number; dimensions: DimensionsDTO; note?: string; at?: string; byName?: string };
  quote: {
    billedWeightKg?: number;
    manualRequired: boolean;
    options: QuoteOptionDTO[];
    selectedRateId?: string;
    sentAt?: string;
    /** Draft options the Office Admin is still choosing from (staff only). */
    draft?: boolean;
  };
  shippingPayment?: { paid: boolean; amount?: number; paidAt?: string };
  /** Staff only: who created it on the admin side, and how it was booked without an online payment. */
  staff?: { createdBy?: string; prepayError?: string; offlinePayment?: { note: string; byName?: string; at?: string } };
  /** International: paying before the parcel is weighed. */
  prepay?: { available: boolean; paid: boolean; additionalDue: number; unavailable?: boolean };
  terminal: {
    carrierName?: string;
    trackingNumber?: string;
    trackingUrl?: string;
    status?: string;
    bookedAt?: string;
    bookingError?: string;
    shipmentId?: string;
    events: { status: string; description?: string; at: string }[];
  };
  refund?: { pickupFee?: RefundDTO; shipping?: RefundDTO };
  cancelledReason?: string;
  statusHistory: { status: ShipmentStatus; note?: string; byRole: string; byName?: string; at: string }[];
};

function refundDto(
  r: { amount?: number | null; reason?: string | null; reference?: string | null; markedAt?: Date | null; byName?: string | null } | null | undefined,
  staff: boolean,
): RefundDTO | undefined {
  if (!r || r.amount == null) return undefined;
  return {
    amount: r.amount,
    reason: r.reason ?? "",
    reference: r.reference ?? undefined,
    markedAt: iso(r.markedAt),
    byName: staff ? r.byName ?? undefined : undefined,
  };
}

type PickupInfo = { reference: string; status: string; amount: number; payment: string };

export async function loadPickupInfo(ids: unknown[]): Promise<Map<string, PickupInfo>> {
  const map = new Map<string, PickupInfo>();
  const real = ids.filter(Boolean);
  if (real.length === 0) return map;
  const bookings = await Booking.find({ _id: { $in: real } } as never)
    .select("bookingReference status pricing.total payment.status")
    .lean();
  for (const b of bookings) {
    map.set(String(b._id), {
      reference: b.bookingReference,
      status: b.status,
      amount: b.pricing?.total ?? 0,
      payment: b.payment?.status ?? "unpaid",
    });
  }
  return map;
}

export function serializeShipment(
  doc: ShipmentHydrated | ShipmentDoc,
  opts: { staff?: boolean; pickup?: PickupInfo; customer?: { name: string; email: string; phone: string } } = {},
): ShipmentDTO {
  const s = (typeof (doc as ShipmentHydrated).toObject === "function" ? (doc as ShipmentHydrated).toObject() : doc) as ShipmentDoc;
  const staff = Boolean(opts.staff);
  const quoteVisibleToCustomer = ["quote_sent", "paid", "booked", "booking_failed", "in_transit", "delivered"].includes(s.status);
  const prepayAvailable =
    s.shipmentType === "international" &&
    Boolean(s.quote?.prepayOffered) &&
    !s.shippingPaidAt &&
    PREPAY_STATUSES.includes(s.status as ShipmentStatus) &&
    (s.quote?.options?.length ?? 0) > 0;
  const selectedOption = (s.quote?.options ?? []).find((o) => o.rateId === s.quote?.selectedRateId);
  const additionalDue =
    s.prepaid && s.status === "quote_sent" && selectedOption ? Math.max(0, Math.round((selectedOption.total - (s.shippingAmount ?? 0)) * 100) / 100) : 0;
  const showQuote = staff || quoteVisibleToCustomer || prepayAvailable;
  const pickup = opts.pickup;

  return {
    id: String(s._id),
    reference: s.reference,
    shipmentType: s.shipmentType as ShipmentDTO["shipmentType"],
    status: s.status as ShipmentStatus,
    createdAt: iso((s as { createdAt?: Date }).createdAt),
    updatedAt: iso((s as { updatedAt?: Date }).updatedAt),
    customer: staff ? opts.customer : undefined,
    sender: s.sender,
    receiver: s.receiver,
    parcel: {
      description: s.parcel.description,
      estimatedWeightKg: s.parcel.estimatedWeightKg,
      dimensions: dimsOf(s.parcel.dimensions),
      declaredValue: s.parcel.declaredValue ?? 0,
      items: (s.parcel.items ?? []).map((i) => ({
        description: i.description,
        quantity: i.quantity,
        value: i.value,
        currency: i.currency ?? "NGN",
        hsCode: i.hsCode ?? undefined,
      })),
    },
    handover: {
      method: s.handover.method as "pickup" | "dropoff",
      pickupBookingReference: pickup?.reference,
      pickupFee: pickup
        ? { amount: pickup.amount, paid: pickup.payment === "paid", status: pickup.payment, bookingStatus: pickup.status }
        : undefined,
      receivedAt: iso(s.handover.receivedAt),
      receivedByName: staff ? s.handover.receivedByName ?? undefined : undefined,
      officeCodeViews: staff
        ? (s.handover.officeCodeViews ?? []).map((v) => ({ byName: v.byName ?? "", at: iso(v.at) ?? "" }))
        : undefined,
    },
    confirmed: s.confirmed?.weightKg
      ? {
          weightKg: s.confirmed.weightKg,
          dimensions: dimsOf(s.confirmed.dimensions),
          note: s.confirmed.note ?? undefined,
          at: iso(s.confirmed.at),
          byName: staff ? s.confirmed.byName ?? undefined : undefined,
        }
      : undefined,
    quote: {
      billedWeightKg: s.quote?.billedWeightKg ?? undefined,
      manualRequired: needsManualQuote(
        s.quote?.billedWeightKg ?? billedWeightKg(s.confirmed?.weightKg ?? s.parcel.estimatedWeightKg),
      ),
      options: showQuote
        ? (s.quote?.options ?? []).map((o) => ({
            rateId: o.rateId,
            carrierName: staff ? o.carrierName : publicCarrierName(o.carrierName),
            carrierLogo: o.carrierLogo ?? undefined,
            service: o.service ?? undefined,
            deliveryTime: o.deliveryTime ?? undefined,
            // Staff see how the price is built. Customers get the total and nothing else, so what we pay the
            // carrier and what we add never leaves the server. (The fields stay, zeroed, so the shape is the same.)
            sourceAmount: staff ? o.sourceAmount : 0,
            sourceCurrency: staff ? o.sourceCurrency : "NGN",
            fxRate: staff ? o.fxRate : 1,
            fxRateUpdatedAt: staff ? iso(o.fxRateUpdatedAt) : undefined,
            baseRate: staff ? o.baseRate : 0,
            tierPercent: staff ? o.tierPercent : 0,
            markup: staff ? o.markup : 0,
            flatFee: staff ? o.flatFee : 0,
            surcharge: staff ? o.surcharge : 0,
            total: o.total,
            manual: Boolean(o.manual),
          }))
        : [],
      selectedRateId: s.quote?.selectedRateId ?? undefined,
      sentAt: iso(s.quote?.sentAt),
      draft: staff ? s.status === "weight_confirmed" && (s.quote?.options?.length ?? 0) > 0 : undefined,
    },
    staff: staff
      ? {
          createdBy: s.createdByStaff?.name ?? undefined,
          prepayError: s.quote?.prepayError ?? undefined,
          offlinePayment: s.offlinePayment?.note
            ? { note: s.offlinePayment.note, byName: s.offlinePayment.byName ?? undefined, at: iso(s.offlinePayment.at) }
            : undefined,
        }
      : undefined,
    prepay:
      s.shipmentType === "international"
        ? {
            available: prepayAvailable,
            paid: Boolean(s.prepaid),
            additionalDue,
            // Prices could not be loaded yet and the customer can still try again before the parcel is weighed.
            unavailable: !prepayAvailable && !s.prepaid && !s.shippingPaidAt && PREPAY_STATUSES.includes(s.status as ShipmentStatus),
          }
        : undefined,
    shippingPayment: s.shippingPaidAt ? { paid: true, amount: s.shippingAmount ?? undefined, paidAt: iso(s.shippingPaidAt) } : { paid: false },
    terminal: {
      carrierName: s.terminal?.carrierName ? (staff ? s.terminal.carrierName : publicCarrierName(s.terminal.carrierName)) : undefined,
      trackingNumber: s.terminal?.trackingNumber ?? undefined,
      trackingUrl: staff ? s.terminal?.trackingUrl ?? undefined : publicTrackingUrl(s.terminal?.trackingUrl),
      status: s.terminal?.status ?? undefined,
      bookedAt: iso(s.terminal?.bookedAt),
      bookingError: staff ? s.terminal?.bookingError ?? undefined : undefined,
      shipmentId: staff ? s.terminal?.shipmentId ?? undefined : undefined,
      events: (s.terminal?.events ?? []).map((e) => ({ status: e.status, description: (staff ? e.description : publicText(e.description)) ?? undefined, at: iso(e.at) ?? "" })),
    },
    refund:
      s.refund?.pickupFee?.amount != null || s.refund?.shipping?.amount != null
        ? {
            pickupFee: refundDto(s.refund?.pickupFee, staff),
            shipping: refundDto(s.refund?.shipping, staff),
          }
        : undefined,
    cancelledReason: s.cancelledReason ?? undefined,
    statusHistory: (s.statusHistory ?? []).map((h) => ({
      status: h.status as ShipmentStatus,
      note: staff ? h.note ?? undefined : publicHistoryNote(h.note),
      byRole: h.byRole ?? "system",
      byName: staff ? h.byName ?? undefined : undefined,
      at: iso(h.at) ?? "",
    })),
  };
}

export async function serializeMany(
  docs: ShipmentHydrated[],
  opts: { staff?: boolean } = {},
): Promise<ShipmentDTO[]> {
  const pickups = await loadPickupInfo(docs.map((d) => d.handover.pickupBooking));
  let customers = new Map<string, { name: string; email: string; phone: string }>();
  if (opts.staff) {
    const users = await User.find({ _id: { $in: docs.map((d) => d.user) } } as never)
      .select("firstName lastName email phone")
      .lean();
    customers = new Map(
      users.map((u) => [String(u._id), { name: `${u.firstName} ${u.lastName}`.trim(), email: u.email, phone: u.phone }]),
    );
  }
  return docs.map((d) =>
    serializeShipment(d, {
      staff: opts.staff,
      pickup: d.handover.pickupBooking ? pickups.get(String(d.handover.pickupBooking)) : undefined,
      customer: customers.get(String(d.user)),
    }),
  );
}

export async function serializeOne(doc: ShipmentHydrated, opts: { staff?: boolean } = {}): Promise<ShipmentDTO> {
  return (await serializeMany([doc], opts))[0];
}
