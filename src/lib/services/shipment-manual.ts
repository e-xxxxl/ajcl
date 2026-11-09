import { ApiError } from "../api";
import type { ShipmentHydrated } from "../../models/Shipment";
import { DELIVERY_MOVES, type ShipmentStatus } from "../../config/shipping";
import { toInternationalPhone } from "../phone";
import { setStatus, type Actor } from "./shipments";
import { buildManualOption } from "./shipment-terminal";
import { notifyCustomer, notifyOffice } from "./shipment-notify";
import type { NotificationType } from "../../models/Notification";

/**
 * Interstate shipments are run by hand: no carrier service is involved. The office sets the price, the customer pays,
 * then the office records the driver who has the parcel (name and phone number, where an international shipment shows a
 * tracking number) and posts delivery updates. International shipments never come through here.
 */

export const isHandRun = (s: { shipmentType: string }): boolean => s.shipmentType === "interstate";

export function requireHandRun(shipment: { shipmentType: string }, what: string): void {
  if (!isHandRun(shipment)) throw new ApiError(`${what} is only for interstate shipments. International shipments are booked with the carrier.`, 409);
}

export function requireInternational(shipment: { shipmentType: string }, what: string): void {
  if (isHandRun(shipment)) throw new ApiError(`${what} is for international shipments. For an interstate shipment, assign a driver instead.`, 409);
}

const naira = (n: number) => `₦${Math.round(n).toLocaleString("en-NG")}`;

/** A driver's number as given: tidied into +234 form when it is a Nigerian number, otherwise kept as typed. */
function tidyPhone(raw: string): string {
  return toInternationalPhone(raw, "NG") ?? raw.trim();
}

/** Set, or change, the price the customer pays. Allowed from weighing until the customer has paid. */
export async function setHandPrice(
  shipment: ShipmentHydrated,
  actor: Actor,
  input: { amount: number; deliveryTime?: string; note?: string },
): Promise<ShipmentHydrated> {
  requireHandRun(shipment, "Setting a price by hand");
  if (!["weight_confirmed", "quote_sent"].includes(shipment.status)) {
    throw new ApiError("Weigh the package before setting its price. Once it is paid the price cannot be changed.", 409);
  }
  const wasSent = shipment.status === "quote_sent";
  const option = buildManualOption(input.amount, { carrierName: "AJCL Interstate", deliveryTime: input.deliveryTime });
  shipment.quote.options = [option] as never;
  shipment.quote.selectedRateId = undefined;
  shipment.quote.sentAt = new Date();
  shipment.quote.note = input.note;
  setStatus(shipment, "quote_sent", actor, input.note || (wasSent ? `Price updated to ${naira(input.amount)}` : `Price set at ${naira(input.amount)}`));
  await shipment.save();

  await notifyCustomer(
    String(shipment.user),
    "shipment_quote_ready",
    wasSent ? "The price for your shipment was updated" : "Your shipping price is ready",
    `Shipment ${shipment.reference} will cost ${naira(input.amount)}${input.deliveryTime ? `, delivery ${input.deliveryTime}` : ""}. Review and pay to ship.`,
    shipment.reference,
  );
  return shipment;
}

/** The customer cannot pay online (or the office was paid by transfer or cash): record that it is paid. Admin only, with a note. */
export async function markPaidByHand(shipment: ShipmentHydrated, actor: Actor, note: string): Promise<ShipmentHydrated> {
  requireHandRun(shipment, "Recording an offline payment this way");
  if (shipment.status !== "quote_sent") throw new ApiError("Set the price first. A payment is recorded against the price the customer was given.", 409);
  const option = shipment.quote.options[0];
  if (!option) throw new ApiError("Set the price first.", 409);
  shipment.quote.selectedRateId = option.rateId;
  shipment.quote.selectedAt = new Date();
  shipment.offlinePayment = { note, by: actor.id, byName: actor.name, at: new Date() } as never;
  setStatus(shipment, "paid", actor, `Paid without an online payment: ${note}`);
  await shipment.save();
  await notifyCustomer(String(shipment.user), "shipment_paid", "Payment recorded", `Your payment for shipment ${shipment.reference} was recorded. We are arranging a driver.`, shipment.reference);
  return shipment;
}

/** Say who has the parcel. First time: the shipment moves from paid to "driver assigned". After that it updates the details. */
export async function assignDriver(
  shipment: ShipmentHydrated,
  actor: Actor,
  input: { driverName?: string; driverPhone: string; note?: string },
): Promise<ShipmentHydrated> {
  requireHandRun(shipment, "Assigning a driver");
  const status = shipment.status as ShipmentStatus;
  if (!["paid", "booked", "in_transit", "delivery_attempted", "delivery_rejected"].includes(status)) {
    throw new ApiError("A driver is assigned once the shipment is paid.", 409);
  }
  const first = !shipment.dispatch?.driverPhone;
  const phone = tidyPhone(input.driverPhone);
  shipment.dispatch = { driverName: input.driverName || undefined, driverPhone: phone, note: input.note || undefined, at: new Date(), byName: actor.name } as never;
  shipment.terminal.bookedAt = shipment.terminal.bookedAt ?? new Date();
  const who = `${input.driverName ? `${input.driverName}, ` : ""}${phone}`;
  if (status === "paid") {
    setStatus(shipment, "booked", actor, `Driver assigned: ${who}${input.note ? `. ${input.note}` : ""}`);
  } else {
    shipment.statusHistory.push({ status, note: `Driver details ${first ? "added" : "updated"}: ${who}`, byRole: actor.role, byName: actor.name, at: new Date() });
  }
  await shipment.save();

  await notifyCustomer(
    String(shipment.user),
    status === "paid" ? "shipment_booked" : "shipment_update",
    status === "paid" ? "A driver is assigned to your shipment" : "Your driver's details were updated",
    `Shipment ${shipment.reference}: ${input.driverName ? `driver ${input.driverName}, ` : "driver "}phone ${phone}.${input.note ? ` ${input.note}` : ""}`,
    shipment.reference,
  );
  return shipment;
}

/** What the customer is told for each move. */
const MOVE_NOTICE: Partial<Record<ShipmentStatus, { type: NotificationType; title: string; line: string }>> = {
  in_transit: { type: "shipment_in_transit", title: "Your shipment is on its way", line: "is now on its way." },
  delivered: { type: "shipment_delivered", title: "Your shipment was delivered", line: "was delivered." },
  delivery_attempted: { type: "shipment_attempted", title: "A delivery was attempted", line: "was attempted, but the driver could not complete the delivery." },
  delivery_rejected: { type: "shipment_rejected", title: "The delivery was rejected", line: "was not accepted by the receiver." },
  returned: { type: "shipment_returned", title: "Your package was returned", line: "could not be delivered and has been returned to the sender." },
};

/**
 * Move a shipment that is being delivered by hand: on the way, a delivery attempted, a delivery rejected, delivered, or the
 * package returned. The moves allowed from each status are DELIVERY_MOVES (the same list the admin page shows). The note
 * is shown to the customer, and is required for a problem.
 */
export async function moveDelivery(shipment: ShipmentHydrated, actor: Actor, input: { status: ShipmentStatus; note?: string }): Promise<ShipmentHydrated> {
  const allowed = DELIVERY_MOVES[shipment.status as ShipmentStatus] ?? [];
  if (!allowed.includes(input.status)) throw new ApiError("That update does not follow from the shipment's current status.", 409);
  const notice = MOVE_NOTICE[input.status];
  if (!notice) throw new ApiError("That is not a delivery update.", 422);
  setStatus(shipment, input.status, actor, input.note);
  await shipment.save();
  await notifyCustomer(
    String(shipment.user),
    notice.type,
    notice.title,
    `Shipment ${shipment.reference} ${notice.line}${input.note ? ` ${input.note}` : ""}`,
    shipment.reference,
    { note: input.note },
  );
  // A rejected delivery and a returned package need someone to follow up with the customer.
  if (input.status === "delivery_rejected" || input.status === "returned") {
    await notifyOffice("shipment_failed", input.status === "returned" ? "Package returned" : "Delivery rejected", `${shipment.reference}: ${input.note ?? ""}`, shipment.reference);
  }
  return shipment;
}

/** Move the delivery along (interstate, run by hand). A driver must have been assigned first. */
export async function advanceDelivery(shipment: ShipmentHydrated, actor: Actor, input: { status: ShipmentStatus; note?: string }): Promise<ShipmentHydrated> {
  requireHandRun(shipment, "Updating the delivery this way");
  if (!shipment.dispatch?.driverPhone || !(shipment.status in DELIVERY_MOVES)) throw new ApiError("Assign a driver first.", 409);
  return moveDelivery(shipment, actor, input);
}

/** A progress note for the customer ("Passed Ore, arriving tomorrow") with no change of status. */
export async function postDeliveryUpdate(shipment: ShipmentHydrated, actor: Actor, note: string): Promise<ShipmentHydrated> {
  requireHandRun(shipment, "Posting an update");
  const status = shipment.status as ShipmentStatus;
  if (!["paid", "booked", "in_transit", "delivery_attempted", "delivery_rejected"].includes(status)) throw new ApiError("Updates can be posted once the shipment is paid and until it is delivered.", 409);
  shipment.statusHistory.push({ status, note, byRole: actor.role, byName: actor.name, at: new Date() });
  await shipment.save();
  await notifyCustomer(String(shipment.user), "shipment_update", "Update on your shipment", `Shipment ${shipment.reference}: ${note}`, shipment.reference, { note });
  return shipment;
}

/** The office is told a hand-run shipment is paid and needs a driver. */
export async function tellOfficeToAssignDriver(shipment: ShipmentHydrated): Promise<void> {
  await notifyOffice("admin_shipment_new", "Paid: assign a driver", `${shipment.reference} is paid. Assign a driver and add the driver's number.`, shipment.reference);
}
