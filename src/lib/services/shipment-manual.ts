import { ApiError } from "../api";
import type { ShipmentHydrated } from "../../models/Shipment";
import type { ShipmentStatus } from "../../config/shipping";
import { toInternationalPhone } from "../phone";
import { setStatus, type Actor } from "./shipments";
import { buildManualOption } from "./shipment-terminal";
import { notifyCustomer, notifyOffice } from "./shipment-notify";

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
  if (!["paid", "booked", "in_transit"].includes(status)) {
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

const ORDER: ShipmentStatus[] = ["booked", "in_transit", "delivered"];

/** Move the delivery along: on the way, then delivered. The note is shown to the customer. */
export async function advanceDelivery(shipment: ShipmentHydrated, actor: Actor, input: { status: "in_transit" | "delivered"; note?: string }): Promise<ShipmentHydrated> {
  requireHandRun(shipment, "Updating the delivery this way");
  const from = ORDER.indexOf(shipment.status as ShipmentStatus);
  if (from < 0 || !shipment.dispatch?.driverPhone) throw new ApiError("Assign a driver first.", 409);
  if (ORDER.indexOf(input.status) <= from) throw new ApiError("That update does not follow from the shipment's current status.", 409);
  setStatus(shipment, input.status, actor, input.note);
  await shipment.save();
  await notifyCustomer(
    String(shipment.user),
    input.status === "delivered" ? "shipment_delivered" : "shipment_in_transit",
    input.status === "delivered" ? "Your shipment was delivered" : "Your shipment is on its way",
    `Shipment ${shipment.reference} is now ${input.status === "delivered" ? "delivered" : "on its way"}.${input.note ? ` ${input.note}` : ""}`,
    shipment.reference,
  );
  return shipment;
}

/** A progress note for the customer ("Passed Ore, arriving tomorrow") with no change of status. */
export async function postDeliveryUpdate(shipment: ShipmentHydrated, actor: Actor, note: string): Promise<ShipmentHydrated> {
  requireHandRun(shipment, "Posting an update");
  const status = shipment.status as ShipmentStatus;
  if (!["paid", "booked", "in_transit"].includes(status)) throw new ApiError("Updates can be posted once the shipment is paid and until it is delivered.", 409);
  shipment.statusHistory.push({ status, note, byRole: actor.role, byName: actor.name, at: new Date() });
  await shipment.save();
  await notifyCustomer(String(shipment.user), "shipment_update", "Update on your shipment", `Shipment ${shipment.reference}: ${note}`, shipment.reference);
  return shipment;
}

/** The office is told a hand-run shipment is paid and needs a driver. */
export async function tellOfficeToAssignDriver(shipment: ShipmentHydrated): Promise<void> {
  await notifyOffice("admin_shipment_new", "Paid: assign a driver", `${shipment.reference} is paid. Assign a driver and add the driver's number.`, shipment.reference);
}
