import { connectToDatabase } from "../db";
import { User } from "../../models/User";
import { Shipment } from "../../models/Shipment";
import { dispatch } from "../notifications";
import type { NotificationType } from "../../models/Notification";
import { env } from "../env";
import { sendEmail } from "../email/send";
import { emailForEvent, renderEmail } from "../email/templates";
import { publicCarrierName } from "../public-text";
import { site } from "../../config/site";

/**
 * Notifications for the shipping feature. Same channels as everything else: an in-app
 * notification plus an email through the existing Resend driver. There is no SMS.
 * None of these ever throw: a failed notification must not undo the work it reports.
 *
 * Who is written to:
 *  - the customer (the account that made the shipment): in-app and email, every step;
 *  - the receiver and the sender, by email, at the steps they care about (created, driver or carrier assigned, on the
 *    way, updates, delivered, cancelled), when their email differs from the customer's and they have not already been told;
 *  - the shipments desk (every admin and office admin), plus any shared inbox in OFFICE_NOTIFY_EMAILS / ADMIN_EMAIL.
 */

export function customerHref(reference: string) {
  return `/dashboard/shipments/${reference}`;
}
export function officeHref(reference: string) {
  return `/admin/shipments/${reference}`;
}

/** Notification types that the sender and receiver are also told about, and the step each one is. */
const PARTY_EVENTS: Partial<Record<NotificationType, PartyEvent>> = {
  shipment_created: "created",
  shipment_booked: "booked",
  shipment_in_transit: "in_transit",
  shipment_update: "update",
  shipment_delivered: "delivered",
};

export async function notifyCustomer(
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
  reference: string,
  opts: { note?: string } = {},
) {
  try {
    await dispatch({ userId, type, title, body, href: customerHref(reference) });
  } catch (err) {
    console.error("[shipments] customer notification failed", err);
  }
  const event = PARTY_EVENTS[type];
  if (event) await notifyParties(reference, event, opts.note);
}

/* ── The sender and the receiver ───────────────────────────────────────── */

export type PartyEvent = "created" | "booked" | "in_transit" | "update" | "delivered" | "cancelled";

type PartyShipment = {
  reference: string;
  shipmentType: string;
  sender: { name: string; email?: string | null; city: string; state: string; country: string };
  receiver: { name: string; email?: string | null; city: string; state: string; country: string };
  dispatch?: { driverName?: string | null; driverPhone?: string | null; note?: string | null } | null;
  terminal?: { carrierName?: string | null; trackingNumber?: string | null } | null;
};

const regionName = (code: string): string => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
};

const place = (p: { city: string; state: string; country: string }) => `${p.city}, ${p.state}${p.country && p.country !== "NG" ? `, ${regionName(p.country)}` : ""}`;

/** What one party is told at one step. Never names the carrier service, never shows prices. */
export function partyContent(role: "sender" | "receiver", event: PartyEvent, s: PartyShipment, note?: string): { subject: string; heading: string; paragraphs: string[] } {
  const ref = s.reference;
  const receiver = role === "receiver";
  const route = `${place(s.sender)} to ${place(s.receiver)}`;
  const package_ = receiver ? `The package from ${s.sender.name}` : `Your package for ${s.receiver.name}`;
  const refLine = `Reference: ${ref}\nRoute: ${route}`;
  const noteLine = note ? [note] : [];

  const driver =
    s.dispatch?.driverPhone
      ? [`Driver: ${[s.dispatch.driverName, s.dispatch.driverPhone].filter(Boolean).join(", ")}`, ...(s.dispatch.note ? [s.dispatch.note] : [])]
      : [];
  const carrier =
    s.terminal?.trackingNumber
      ? [`Delivery service: ${publicCarrierName(s.terminal.carrierName)}`, `Tracking number: ${s.terminal.trackingNumber}`]
      : [];

  switch (event) {
    case "created":
      return receiver
        ? {
            subject: `A package is being sent to you (${ref})`,
            heading: "A package is on its way to you",
            paragraphs: [`${s.sender.name} is sending you a package with ${site.name}.`, refLine, "We will email you when it is on its way and when it is delivered."],
          }
        : {
            subject: `Your shipment ${ref} is registered`,
            heading: "We have your shipment request",
            paragraphs: [`Your package for ${s.receiver.name} is registered with ${site.name}.`, refLine, "We will email you at each step."],
          };
    case "booked":
      return {
        subject: s.dispatch?.driverPhone ? `A driver has the package (${ref})` : `The package is booked (${ref})`,
        heading: s.dispatch?.driverPhone ? "A driver has been assigned" : "The package has been booked for delivery",
        paragraphs: [`${package_} has been ${s.dispatch?.driverPhone ? "given to a driver" : "booked for delivery"}.`, refLine, ...driver, ...carrier, ...noteLine],
      };
    case "in_transit":
      return {
        subject: `The package is on its way (${ref})`,
        heading: receiver ? "Your package is on its way" : "Your package is on its way to the receiver",
        paragraphs: [`${package_} is on its way.`, refLine, ...driver, ...carrier, ...noteLine],
      };
    case "update":
      return {
        subject: `An update on the package (${ref})`,
        heading: "An update on the package",
        paragraphs: [...noteLine, refLine, ...driver],
      };
    case "delivered":
      return {
        subject: `The package was delivered (${ref})`,
        heading: receiver ? "Your package was delivered" : "The package was delivered",
        paragraphs: [`${package_} has been delivered.`, refLine, ...noteLine, `Thank you for choosing ${site.name}.`],
      };
    case "cancelled":
      return {
        subject: `The shipment was cancelled (${ref})`,
        heading: "This shipment was cancelled",
        paragraphs: [`The shipment of ${receiver ? `the package from ${s.sender.name}` : `your package for ${s.receiver.name}`} was cancelled.`, refLine, ...noteLine, "If you have a question, reply to this email."],
      };
  }
}

/**
 * Email the receiver and the sender about a step, when they have an email address that is not the customer's own
 * (the customer is already written to) and is not the other party's. Needs no account: they only get an email.
 */
export async function notifyParties(reference: string, event: PartyEvent, note?: string): Promise<void> {
  try {
    await connectToDatabase();
    const s = await Shipment.findOne({ reference }).lean();
    if (!s) return;
    const owner = await User.findById(s.user).select("email").lean();
    const seen = new Set<string>(owner?.email ? [owner.email.toLowerCase()] : []);
    const targets: { to: string; role: "sender" | "receiver" }[] = [];
    for (const [role, party] of [["receiver", s.receiver], ["sender", s.sender]] as const) {
      const to = (party.email ?? "").trim().toLowerCase();
      if (!to.includes("@") || seen.has(to)) continue;
      seen.add(to);
      targets.push({ to, role });
    }
    for (const { to, role } of targets) {
      const c = partyContent(role, event, s as unknown as PartyShipment, note);
      const { html, text } = renderEmail({
        preview: c.paragraphs[0] ?? c.heading,
        heading: c.heading,
        paragraphs: c.paragraphs,
        footerNote: `You are receiving this email because a shipment involving you was arranged with ${site.name}.`,
      });
      await sendEmail({ to, subject: c.subject, html, text });
    }
  } catch (err) {
    console.error("[shipments] party notification failed", err);
  }
}

/* ── The shipments desk ────────────────────────────────────────────────── */

async function adminIds(opts: { superOnly?: boolean; office?: boolean }): Promise<string[]> {
  await connectToDatabase();
  const filter: Record<string, unknown> = opts.superOnly
    ? { role: "admin", superAdmin: true }
    : { role: { $in: opts.office ? ["admin", "office_admin"] : ["admin"] } };
  const users = await User.find(filter as never).select("_id").lean();
  return users.map((u) => String(u._id));
}

/** Everyone who works the shipments desk: Office Admins and admins, and the shared inboxes. */
export async function notifyOffice(type: NotificationType, title: string, body: string, reference: string) {
  try {
    const ids = await adminIds({ office: true });
    await Promise.all(ids.map((userId) => dispatch({ userId, type, title, body, href: officeHref(reference) })));
    await emailSharedInboxes(ids, type, title, body, officeHref(reference));
  } catch (err) {
    console.error("[shipments] office notification failed", err);
  }
}

export async function notifySuperAdmins(type: NotificationType, title: string, body: string, href: string) {
  try {
    const ids = await adminIds({ superOnly: true });
    await Promise.all(ids.map((userId) => dispatch({ userId, type, title, body, href })));
  } catch (err) {
    console.error("[shipments] super admin notification failed", err);
  }
}

/** A copy to each shared inbox (ADMIN_EMAIL, OFFICE_NOTIFY_EMAILS) that is not already one of the admins written to above. */
async function emailSharedInboxes(adminUserIds: string[], type: NotificationType, title: string, body: string, href: string) {
  if (env.officeInboxes.length === 0) return;
  const users = await User.find({ _id: { $in: adminUserIds } } as never).select("email").lean();
  const have = new Set(users.map((u) => String(u.email).toLowerCase()));
  const extra = env.officeInboxes.filter((e) => !have.has(e));
  if (extra.length === 0) return;
  const { subject, html, text } = emailForEvent({ type, title, body, href });
  await sendEmail({ to: extra, subject, html, text });
}
