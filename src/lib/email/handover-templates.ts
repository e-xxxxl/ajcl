import { site } from "../../config/site";
import { renderEmail, esc, absUrl } from "./templates";

/**
 * Emails for the secure handover flow: the confirmation sent to the sender and
 * the receiver once a booking is paid (each with their own code + QR), and the
 * "your rider is assigned" email with the rider's name, phone and plate number.
 */

const AMBER = "#ffb100";
const INK = "#141414";
const MUTED = "#6b6b6b";
const SURFACE = "#f7f7f5";
const LINE = "#e6e6e6";

export type EmailOut = { subject: string; html: string; text: string };

export type RiderInfo = { name?: string; phone?: string; plate?: string };

function spaced(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** The big code card: QR image (inline CID attachment) plus the 6 digits underneath. */
function codeCard(opts: { label: string; code: string; qrCid?: string; caption: string }): string {
  const qr = opts.qrCid
    ? `<img src="cid:${esc(opts.qrCid)}" width="180" height="180" alt="QR code for ${esc(opts.label)}" style="display:block;margin:0 auto 12px;width:180px;height:180px;border-radius:10px;border:1px solid ${LINE};background:#ffffff;">`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;">
    <tr><td align="center" style="padding:20px 16px;border-radius:14px;background:${SURFACE};border:1px solid ${LINE};">
      <p style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};">${esc(opts.label)}</p>
      ${qr}
      <p style="margin:0;font-size:32px;line-height:1.1;font-weight:700;letter-spacing:0.14em;color:${INK};font-family:'Courier New',Courier,monospace;">${esc(spaced(opts.code))}</p>
      <p style="margin:10px 0 0;font-size:12px;line-height:1.5;color:${MUTED};">${esc(opts.caption)}</p>
    </td></tr>
  </table>`;
}

/** Numbered "how it works" list. */
function steps(title: string, items: string[]): string {
  const rows = items
    .map(
      (item, i) => `<tr>
      <td valign="top" style="width:30px;padding:0 0 12px;">
        <div style="width:22px;height:22px;border-radius:11px;background:${INK};color:#ffffff;font-size:12px;font-weight:700;line-height:22px;text-align:center;">${i + 1}</div>
      </td>
      <td valign="top" style="padding:1px 0 12px;font-size:14px;line-height:1.55;color:${INK};">${esc(item)}</td>
    </tr>`,
    )
    .join("");
  return `<p style="margin:6px 0 12px;font-size:13px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${MUTED};">${esc(title)}</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">${rows}</table>`;
}

/** Amber "keep it private" callout. */
function privacyWarning(text: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;">
    <tr><td style="padding:14px 16px;border-radius:12px;background:#fff7e0;border:1px solid ${AMBER};">
      <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:${INK};">Keep this code private</p>
      <p style="margin:0;font-size:13px;line-height:1.55;color:${INK};">${esc(text)}</p>
    </td></tr>
  </table>`;
}

function riderCard(rider: RiderInfo): string {
  const phone = rider.phone
    ? `<a href="tel:${esc(rider.phone)}" style="color:${INK};text-decoration:none;font-weight:700;">${esc(rider.phone)}</a>`
    : "Not provided";
  const cell = (label: string, value: string) =>
    `<td valign="top" style="padding:14px 16px;">
      <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};">${label}</p>
      <p style="margin:0;font-size:15px;line-height:1.4;color:${INK};">${value}</p>
    </td>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;border-radius:14px;background:${SURFACE};border:1px solid ${LINE};">
    <tr>
      ${cell("Rider", `<strong>${esc(rider.name || "Not provided")}</strong>`)}
      ${cell("Phone", phone)}
      ${cell("Plate number", `<strong style="font-family:'Courier New',Courier,monospace;letter-spacing:0.08em;">${esc(rider.plate || "Not provided")}</strong>`)}
    </tr>
  </table>`;
}

function riderText(rider: RiderInfo): string[] {
  return [
    `Rider: ${rider.name || "Not provided"}`,
    `Phone: ${rider.phone || "Not provided"}`,
    `Plate number: ${rider.plate || "Not provided"}`,
  ];
}

/* ── 1. Booking confirmed + paid ────────────────────────────────────────── */

export function senderConfirmationEmail(p: {
  name?: string;
  ref: string;
  pickupAddress: string;
  destinationAddress: string;
  scheduledLabel: string;
  vehicleName: string;
  pickupCode: string;
  qrCid?: string;
}): EmailOut {
  const warning =
    "Do not share it by phone, chat or message, and do not give it to anyone who says they are a rider until they are physically standing in front of you. AJ Courier & Logistics will never ask you for this code by phone or message.";
  const howItWorks = [
    "We assign a rider. You will get another email with their name, phone number and plate number.",
    "When the rider arrives, check that their name and plate number match that email.",
    "Show them this QR code, or read out the 6 digits. Only do this once the rider is with you.",
    "The rider confirms the pickup in their app. You, the receiver and our team are updated instantly.",
  ];

  const { html, text } = renderEmail({
    preview: `Booking ${p.ref} is confirmed. Your pickup code is inside.`,
    heading: "Your booking is confirmed",
    paragraphs: [
      p.name ? `Hi ${p.name},` : "Hi,",
      `We have received your payment and booking ${p.ref} is confirmed.`,
      `Pickup: ${p.pickupAddress}\nDelivery to: ${p.destinationAddress}\nScheduled: ${p.scheduledLabel}\nVehicle: ${p.vehicleName}`,
      "Below is your pickup code. It proves to the rider that they are collecting the right package from you.",
    ],
    block:
      codeCard({
        label: "Your pickup code",
        code: p.pickupCode,
        qrCid: p.qrCid,
        caption: "Show the QR or read out the digits. It can only be used once.",
      }) +
      privacyWarning(warning) +
      steps("How it works", howItWorks),
    blockText: [
      `YOUR PICKUP CODE: ${spaced(p.pickupCode)}`,
      `KEEP THIS CODE PRIVATE. ${warning}`,
      "",
      "HOW IT WORKS",
      ...howItWorks.map((s, i) => `${i + 1}. ${s}`),
    ],
    cta: { label: "View your booking", href: `/dashboard/bookings/${p.ref}` },
  });

  return { subject: `Booking ${p.ref} confirmed: your pickup code inside`, html, text };
}

export function receiverConfirmationEmail(p: {
  name?: string;
  ref: string;
  senderName: string;
  pickupAddress: string;
  destinationAddress: string;
  scheduledLabel: string;
  deliveryCode: string;
  qrCid?: string;
  trackingToken: string;
}): EmailOut {
  const trackingUrl = absUrl(`/track/${p.trackingToken}`) ?? "";
  const warning =
    "Do not share it by phone, chat or message, and do not forward this email. Only give it to the rider once they are physically with you and you have your package. AJ Courier & Logistics will never ask you for this code by phone or message.";
  const howItWorks = [
    "We assign a rider and email you their name, phone number and plate number.",
    "Follow your delivery live at any time with the button below.",
    "When the rider arrives with your package, check that their name and plate number match.",
    "Show them this QR code, or read out the 6 digits, only once the rider is with you.",
    "The rider confirms delivery and everyone is updated. The code can only be used once.",
  ];

  const { html, text } = renderEmail({
    preview: `A delivery is on its way to you (booking ${p.ref}). Your delivery code is inside.`,
    heading: "A package is on its way to you",
    paragraphs: [
      p.name ? `Hi ${p.name},` : "Hi,",
      `${p.senderName} has booked a delivery to you with ${site.name} (reference ${p.ref}).`,
      `From: ${p.pickupAddress}\nTo: ${p.destinationAddress}\nScheduled: ${p.scheduledLabel}`,
      "Below is your delivery code. It proves to the rider that the package is reaching the right person.",
    ],
    block:
      codeCard({
        label: "Your delivery code",
        code: p.deliveryCode,
        qrCid: p.qrCid,
        caption: "Show the QR or read out the digits. It can only be used once.",
      }) +
      privacyWarning(warning) +
      steps("How it works", howItWorks),
    blockText: [
      `YOUR DELIVERY CODE: ${spaced(p.deliveryCode)}`,
      `KEEP THIS CODE PRIVATE. ${warning}`,
      "",
      "HOW IT WORKS",
      ...howItWorks.map((s, i) => `${i + 1}. ${s}`),
    ],
    cta: { label: "Track this delivery", href: `/track/${p.trackingToken}` },
    note: `If the button does not work, copy and paste this link into your browser: ${trackingUrl}`,
    footerNote: `You are receiving this email because someone booked a delivery to you with ${site.name}.`,
  });

  return { subject: `A delivery is on its way to you (booking ${p.ref})`, html, text };
}

/* ── 2. Rider assigned ──────────────────────────────────────────────────── */

export function senderRiderAssignedEmail(p: {
  name?: string;
  ref: string;
  rider: RiderInfo;
  scheduledLabel: string;
}): EmailOut {
  const reminder =
    "Before you hand over the package, check that the rider's name and plate number match the details above. Only share your pickup code (in your confirmation email and on your booking page) once the rider is physically with you.";
  const { html, text } = renderEmail({
    preview: `${p.rider.name || "Your rider"} will collect your package for booking ${p.ref}.`,
    heading: "A rider has been assigned to your delivery",
    paragraphs: [
      p.name ? `Hi ${p.name},` : "Hi,",
      `A rider has been assigned to collect your package for booking ${p.ref}. Pickup is scheduled for ${p.scheduledLabel}.`,
    ],
    block: riderCard(p.rider) + privacyWarning(reminder),
    blockText: [...riderText(p.rider), "", `KEEP YOUR CODE PRIVATE. ${reminder}`],
    cta: { label: "View your booking", href: `/dashboard/bookings/${p.ref}` },
  });
  return { subject: `Your rider for booking ${p.ref}: ${p.rider.name || "assigned"}`, html, text };
}

export function receiverRiderAssignedEmail(p: {
  name?: string;
  ref: string;
  rider: RiderInfo;
  scheduledLabel: string;
  trackingToken: string;
}): EmailOut {
  const reminder =
    "When the rider arrives, check that their name and plate number match the details above. Only share your delivery code once the rider is physically with you and you have your package.";
  const { html, text } = renderEmail({
    preview: `${p.rider.name || "A rider"} will deliver your package (booking ${p.ref}).`,
    heading: "A rider has been assigned to your delivery",
    paragraphs: [
      p.name ? `Hi ${p.name},` : "Hi,",
      `A rider has been assigned to deliver the package for booking ${p.ref}. It is scheduled for ${p.scheduledLabel}.`,
    ],
    block: riderCard(p.rider) + privacyWarning(reminder),
    blockText: [...riderText(p.rider), "", `KEEP YOUR CODE PRIVATE. ${reminder}`],
    cta: { label: "Track this delivery", href: `/track/${p.trackingToken}` },
    footerNote: `You are receiving this email because someone booked a delivery to you with ${site.name}.`,
  });
  return { subject: `Your rider for booking ${p.ref}: ${p.rider.name || "assigned"}`, html, text };
}
