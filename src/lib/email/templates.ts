import { env } from "../env";
import { site } from "../../config/site";
import type { NotificationType } from "../../models/Notification";

const NAVY = "#16233a";
const AMBER = "#ffb100";
const INK = "#141414";
const MUTED = "#6b6b6b";
const SURFACE = "#f7f7f5";
const LINE = "#e6e6e6";

const LOGO_URL = `${env.frontendUrl}/logo.png`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function absUrl(href?: string): string | undefined {
  if (!href) return undefined;
  if (/^https?:\/\//i.test(href)) return href;
  return `${env.frontendUrl}${href.startsWith("/") ? "" : "/"}${href}`;
}

type LayoutInput = {
  preview: string;
  heading: string;
  /** Paragraphs of body copy (plain text; rendered as <p>). */
  paragraphs: string[];
  cta?: { label: string; href: string };
  /** Small print under the button, e.g. a fallback link. */
  note?: string;
};

/** Shared, email-client-safe HTML shell. */
export function renderEmail(input: LayoutInput): { html: string; text: string } {
  const ctaUrl = input.cta ? absUrl(input.cta.href) : undefined;

  const paragraphsHtml = input.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${INK};">${esc(p).replace(
          /\n/g,
          "<br>",
        )}</p>`,
    )
    .join("");

  const ctaHtml =
    input.cta && ctaUrl
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;">
           <tr><td style="border-radius:999px;background:${INK};">
             <a href="${ctaUrl}" style="display:inline-block;padding:13px 30px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">${esc(
               input.cta.label,
             )}</a>
           </td></tr>
         </table>`
      : "";

  const noteHtml = input.note
    ? `<p style="margin:14px 0 0;font-size:12px;line-height:1.6;color:${MUTED};">${esc(input.note)}</p>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(input.heading)}</title></head>
<body style="margin:0;padding:0;background:${SURFACE};-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(input.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE};padding:24px 12px;font-family:'Quicksand',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="background:#ffffff;border-radius:16px 16px 0 0;border:1px solid ${LINE};border-bottom:none;padding:24px 28px 18px;" align="left">
        <img src="${LOGO_URL}" alt="${esc(site.name)}" height="44" style="height:44px;width:auto;display:block;">
      </td></tr>
      <tr><td style="height:4px;background:${AMBER};line-height:4px;font-size:0;">&nbsp;</td></tr>
      <tr><td style="background:#ffffff;padding:30px 28px;border-left:1px solid ${LINE};border-right:1px solid ${LINE};">
        <h1 style="margin:0 0 18px;font-size:21px;line-height:1.3;color:${INK};font-weight:700;">${esc(
          input.heading,
        )}</h1>
        ${paragraphsHtml}
        ${ctaHtml}
        ${noteHtml}
      </td></tr>
      <tr><td style="background:#ffffff;border-radius:0 0 16px 16px;border:1px solid ${LINE};border-top:none;padding:22px 28px;">
        <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:${MUTED};">
          <strong style="color:${INK};">${esc(site.name)}</strong> — ${esc(site.tagline)}
        </p>
        <p style="margin:0;font-size:12px;line-height:1.6;color:${MUTED};">
          <a href="${site.contact.phoneHref}" style="color:${MUTED};text-decoration:none;">${esc(
            site.contact.phone,
          )}</a>
          &nbsp;·&nbsp;
          <a href="mailto:${site.contact.email}" style="color:${MUTED};text-decoration:none;">${esc(
            site.contact.email,
          )}</a>
          &nbsp;·&nbsp; ${esc(site.contact.address)}
        </p>
        <p style="margin:12px 0 0;font-size:11px;line-height:1.6;color:#9a9a9a;">
          You're receiving this email because you have an account with ${esc(site.name)}.
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  const text = [
    input.heading,
    "",
    ...input.paragraphs,
    ...(input.cta && ctaUrl ? ["", `${input.cta.label}: ${ctaUrl}`] : []),
    ...(input.note ? ["", input.note] : []),
    "",
    "—",
    `${site.name} · ${site.contact.phone} · ${site.contact.email}`,
  ].join("\n");

  return { html, text };
}

/* ── Per-event content ──────────────────────────────────────────────────── */

type EventContent = {
  subject: string;
  heading: string;
  paragraphs: string[];
  cta?: { label: string; href: string };
};

type EventCtx = {
  ref: string;
  name: string;
  driver?: { name?: string; phone?: string; plate?: string };
};

const EVENTS: Partial<Record<NotificationType, (ctx: EventCtx) => EventContent>> = {
  booking_created: ({ ref }) => ({
    subject: `Complete payment for booking ${ref}`,
    heading: "Your booking has been created",
    paragraphs: [
      `Booking ${ref} is ready. Complete payment to confirm it and we'll assign a rider.`,
      "Your booking is held until payment is received.",
    ],
    cta: { label: "Complete payment", href: `/dashboard/bookings/${ref}` },
  }),
  payment_succeeded: ({ ref }) => ({
    subject: `Payment received — booking ${ref} confirmed`,
    heading: "Payment received",
    paragraphs: [
      `We've received your payment for booking ${ref}. It's now confirmed and we'll assign a rider shortly.`,
      "You can follow the delivery status from your dashboard.",
    ],
    cta: { label: "Track this delivery", href: `/dashboard/bookings/${ref}` },
  }),
  payment_failed: ({ ref }) => ({
    subject: `Payment didn't go through for booking ${ref}`,
    heading: "Your payment didn't go through",
    paragraphs: [
      `The payment for booking ${ref} wasn't completed. No charge was made.`,
      "You can retry the payment from your dashboard at any time.",
    ],
    cta: { label: "Retry payment", href: `/dashboard/bookings/${ref}` },
  }),
  booking_confirmed: ({ ref }) => ({
    subject: `Booking ${ref} is confirmed`,
    heading: "Booking confirmed",
    paragraphs: [`Booking ${ref} is confirmed. We'll assign a rider and keep you updated.`],
    cta: { label: "View booking", href: `/dashboard/bookings/${ref}` },
  }),
  driver_assigned: ({ ref, driver }) => {
    const bits = [
      driver?.name ? `Rider: ${driver.name}` : "",
      driver?.phone ? `Phone: ${driver.phone}` : "",
      driver?.plate ? `Plate number: ${driver.plate}` : "",
    ].filter(Boolean);
    return {
      subject: `A rider is on the way for booking ${ref}`,
      heading: "Rider assigned",
      paragraphs: [
        `A rider has been assigned to booking ${ref} and is heading to pickup.`,
        ...(bits.length ? [bits.join("\n")] : []),
        "You can call the rider or check the plate number on arrival.",
      ],
      cta: { label: "Track your rider", href: `/dashboard/bookings/${ref}` },
    };
  },
  in_transit: ({ ref }) => ({
    subject: `Your package for ${ref} is on the way`,
    heading: "Package in transit",
    paragraphs: [`Your package for booking ${ref} has been picked up and is on the way to its destination.`],
    cta: { label: "Track delivery", href: `/dashboard/bookings/${ref}` },
  }),
  delivered: ({ ref }) => ({
    subject: `Delivered — booking ${ref}`,
    heading: "Your package has been delivered",
    paragraphs: [
      `Booking ${ref} has been delivered. Thank you for choosing ${site.name}.`,
      "We'd love to carry your next delivery too.",
    ],
    cta: { label: "Book another delivery", href: `/book` },
  }),
  booking_cancelled: ({ ref }) => ({
    subject: `Booking ${ref} has been cancelled`,
    heading: "Booking cancelled",
    paragraphs: [
      `Booking ${ref} has been cancelled.`,
      "If you've already paid and expect a refund, reply to this email and our team will help.",
    ],
    cta: { label: "View booking", href: `/dashboard/bookings/${ref}` },
  }),
  admin_new_booking: ({ ref }) => ({
    subject: `New paid booking: ${ref}`,
    heading: "New paid booking needs a rider",
    paragraphs: [`${ref} has been paid for and is waiting to be assigned a rider.`],
    cta: { label: "Open in admin", href: `/admin/bookings/${ref}` },
  }),
};

/** Build a full email ({subject, html, text}) for a notification event. */
export function emailForEvent(params: {
  type: NotificationType;
  bookingReference?: string;
  recipientName?: string;
  driver?: { name?: string; phone?: string; plate?: string };
  /** Fallbacks if the event isn't specially templated. */
  title: string;
  body: string;
  href?: string;
}): { subject: string; html: string; text: string } {
  const ref = params.bookingReference ?? "";
  const build = EVENTS[params.type];

  const content: EventContent = build
    ? build({ ref, name: params.recipientName ?? "", driver: params.driver })
    : {
        subject: params.title,
        heading: params.title,
        paragraphs: [params.body],
        cta: params.href ? { label: "Open", href: params.href } : undefined,
      };

  const { html, text } = renderEmail({
    preview: content.paragraphs[0] ?? content.heading,
    heading: content.heading,
    paragraphs: content.paragraphs,
    cta: content.cta,
  });
  return { subject: content.subject, html, text };
}

/** Password-reset email. */
export function passwordResetEmail(params: {
  name?: string;
  resetUrl: string;
}): { subject: string; html: string; text: string } {
  const { html, text } = renderEmail({
    preview: "Reset your AJ Courier & Logistics password",
    heading: "Reset your password",
    paragraphs: [
      params.name ? `Hi ${params.name},` : "Hi,",
      "We received a request to reset the password on your account. Click the button below to choose a new one. This link expires in 1 hour.",
      "If you didn't request this, you can safely ignore this email — your password won't change.",
    ],
    cta: { label: "Reset password", href: params.resetUrl },
    note: `If the button doesn't work, copy and paste this link into your browser: ${params.resetUrl}`,
  });
  return { subject: "Reset your AJ Courier & Logistics password", html, text };
}

/** Welcome email on signup. */
export function welcomeEmail(params: { name?: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const { html, text } = renderEmail({
    preview: "Welcome to AJ Courier & Logistics",
    heading: `Welcome${params.name ? `, ${params.name}` : ""}!`,
    paragraphs: [
      `Your ${site.name} account is ready. Book a bike, mini van or mini truck in minutes — with the full fare shown upfront and live tracking from pickup to drop-off.`,
    ],
    cta: { label: "Book a delivery", href: "/book" },
  });
  return { subject: `Welcome to ${site.name}`, html, text };
}
