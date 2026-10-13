import { connectToDatabase } from "../db";
import { Notification, type NotificationType } from "../../models/Notification";
import { User } from "../../models/User";
import type { BookingDoc } from "../../models/Booking";
import { isEmailConfigured } from "../env";
import { sendEmail } from "../email/send";
import { emailForEvent } from "../email/templates";

/**
 * Notification service.
 *
 * In-app notifications (a Notification document + the dashboard bell) are always
 * created. Extra channels are registered as drivers in `CHANNEL_DRIVERS`;
 * `dispatch()` loops over them. The Resend email driver is registered below.
 */

export type NotifyChannel = "in_app" | "email" | "sms" | "whatsapp";

export interface ChannelDriver {
  channel: NotifyChannel;
  enabled(): boolean;
  send(payload: NotificationPayload): Promise<void>;
}

export type NotificationPayload = {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  href?: string;
  bookingId?: string;
  bookingReference?: string;
  /** Rider details, for the "rider assigned" email. */
  driver?: { name?: string; phone?: string; plate?: string };
  /** Contact hints for other channels. */
  email?: string;
  phone?: string;
  /** Create the in-app notification only. A richer email is sent separately. */
  skipEmail?: boolean;
};

const CHANNEL_DRIVERS: ChannelDriver[] = [];

export function registerChannelDriver(driver: ChannelDriver) {
  CHANNEL_DRIVERS.push(driver);
}

export async function dispatch(payload: NotificationPayload): Promise<void> {
  const channels: NotifyChannel[] = ["in_app"];

  try {
    await connectToDatabase();
    await Notification.create({
      user: payload.userId,
      type: payload.type,
      title: payload.title,
      body: payload.body,
      href: payload.href,
      booking: payload.bookingId,
      channels,
    });
  } catch (err) {
    console.error("[notifications] failed to persist in-app notification", err);
  }

  for (const driver of CHANNEL_DRIVERS) {
    if (payload.skipEmail && driver.channel === "email") continue;
    if (!driver.enabled()) continue;
    try {
      await driver.send(payload);
      channels.push(driver.channel);
    } catch (err) {
      console.error(`[notifications] ${driver.channel} driver failed`, err);
    }
  }
}

/* ── Email channel (Resend) ─────────────────────────────────────────────── */

registerChannelDriver({
  channel: "email",
  enabled: () => isEmailConfigured,
  async send(payload) {
    let to = payload.email;
    let firstName = "";
    try {
      const user = await User.findById(payload.userId).lean();
      if (user) {
        to = to || user.email;
        firstName = user.firstName;
      }
    } catch {
      /* fall back to payload.email */
    }
    if (!to) return;

    const { subject, html, text } = emailForEvent({
      type: payload.type,
      bookingReference: payload.bookingReference,
      recipientName: firstName,
      driver: payload.driver,
      title: payload.title,
      body: payload.body,
      href: payload.href,
    });
    await sendEmail({ to, subject, html, text });
  },
});

/* ── Templates ──────────────────────────────────────────────────────────── */

type BookingLike = Pick<BookingDoc, "bookingReference"> & {
  _id: unknown;
  assignedDriver?: { name?: string | null; phone?: string | null; plate?: string | null } | null;
};

function bookingHref(ref: string) {
  return `/dashboard/bookings/${ref}`;
}

export type AdminAlertKind =
  | "admin_pickup_confirmed"
  | "admin_delivery_confirmed"
  | "admin_code_locked"
  | "admin_handover_flagged";

export const notify = {
  async bookingCreated(userId: string, booking: BookingLike, contact?: { email?: string; phone?: string }) {
    return dispatch({
      userId,
      type: "booking_created",
      title: "Booking created",
      body: `Your booking ${booking.bookingReference} has been created. Complete payment to confirm it.`,
      href: bookingHref(booking.bookingReference),
      bookingId: String(booking._id),
      bookingReference: booking.bookingReference,
      ...contact,
    });
  },
  async paymentSucceeded(userId: string, booking: BookingLike) {
    return dispatch({
      userId,
      type: "payment_succeeded",
      title: "Payment received",
      body: `We received your payment for ${booking.bookingReference}. Your booking is confirmed.`,
      href: bookingHref(booking.bookingReference),
      bookingId: String(booking._id),
      bookingReference: booking.bookingReference,
      // The confirmation email (pickup code + QR) is sent by sendConfirmationEmails.
      skipEmail: true,
    });
  },
  async paymentFailed(userId: string, booking: BookingLike) {
    return dispatch({
      userId,
      type: "payment_failed",
      title: "Payment failed",
      body: `Your payment for ${booking.bookingReference} did not go through. You can retry from your dashboard.`,
      href: bookingHref(booking.bookingReference),
      bookingId: String(booking._id),
      bookingReference: booking.bookingReference,
    });
  },
  async statusChanged(
    userId: string,
    booking: BookingLike,
    status: string,
    opts: { skipEmail?: boolean; detail?: string } = {},
  ) {
    const map: Record<string, { type: NotificationType; title: string; body: string }> = {
      confirmed: {
        type: "booking_confirmed",
        title: "Booking confirmed",
        body: `Booking ${booking.bookingReference} is confirmed. We'll assign a rider shortly.`,
      },
      driver_assigned: {
        type: "driver_assigned",
        title: "Rider assigned",
        body: `A rider has been assigned to ${booking.bookingReference} and is heading to pickup.`,
      },
      in_transit: {
        type: "in_transit",
        title: "Package in transit",
        body: `Your package for ${booking.bookingReference} has been picked up and is on the way.`,
      },
      delivered: {
        type: "delivered",
        title: "Delivered",
        body: `Booking ${booking.bookingReference} has been delivered. Thank you for choosing us!`,
      },
      cancelled: {
        type: "booking_cancelled",
        title: "Booking cancelled",
        body: `Booking ${booking.bookingReference} has been cancelled.`,
      },
      returned: {
        type: "booking_returned",
        title: "Order returned",
        body: `Booking ${booking.bookingReference} could not be delivered and has been returned.`,
      },
    };
    const t = map[status];
    if (!t) return;
    const d = booking.assignedDriver;
    return dispatch({
      userId,
      type: t.type,
      title: t.title,
      body: opts.detail ? `${t.body} ${opts.detail}` : t.body,
      href: bookingHref(booking.bookingReference),
      bookingId: String(booking._id),
      bookingReference: booking.bookingReference,
      skipEmail: opts.skipEmail,
      driver:
        status === "driver_assigned" && d
          ? {
              name: d.name ?? undefined,
              phone: d.phone ?? undefined,
              plate: d.plate ?? undefined,
            }
          : undefined,
    });
  },
  async adminNewBooking(
    adminUserId: string,
    booking: BookingLike,
    info: { riderName?: string; partnerName?: string; total?: number } = {},
  ) {
    const rider = info.riderName;
    const partner = info.partnerName;
    const money = typeof info.total === "number" ? ` (₦${info.total.toLocaleString("en-NG")} on account)` : "";
    return dispatch({
      userId: adminUserId,
      type: "admin_new_booking",
      title: partner
        ? rider
          ? "New partner order, rider assigned"
          : "New partner order needs a rider"
        : rider
          ? "New paid booking, rider assigned"
          : "New paid booking needs a rider",
      body: partner
        ? rider
          ? `${partner} placed order ${booking.bookingReference}${money}. It was automatically assigned to ${rider}.`
          : `${partner} placed order ${booking.bookingReference}${money}, but no rider was free to take it automatically. Please assign one.`
        : rider
          ? `${booking.bookingReference} has been paid and was automatically assigned to ${rider}.`
          : `${booking.bookingReference} has been paid, but no rider was free to take it automatically. Please assign one.`,
      href: `/admin/bookings/${booking.bookingReference}`,
      bookingId: String(booking._id),
      bookingReference: booking.bookingReference,
    });
  },
  /** To a partner: the admin recorded a payment against their balance. */
  async partnerPaymentRecorded(partnerId: string, amount: number, outstanding: number) {
    const fmt = (n: number) => `₦${n.toLocaleString("en-NG")}`;
    return dispatch({
      userId: partnerId,
      type: "partner_payment_recorded",
      title: "Payment recorded",
      body:
        outstanding > 0
          ? `We recorded your payment of ${fmt(amount)}. You still owe ${fmt(outstanding)}.`
          : `We recorded your payment of ${fmt(amount)}. Your account is fully settled. Thank you.`,
      href: "/dashboard/account",
    });
  },
  /** To the rider themselves — a new job landed in their dashboard. */
  async riderJobAssigned(riderId: string, booking: BookingLike) {
    return dispatch({
      userId: riderId,
      type: "rider_job_assigned",
      title: "New delivery assigned",
      body: `You've been assigned booking ${booking.bookingReference}. Open it for pickup details.`,
      href: "/rider",
      bookingId: String(booking._id),
      bookingReference: booking.bookingReference,
    });
  },
  /** To every admin — fired by the rider's pickup/delivery scan, and on a locked code. */
  async adminAlert(
    adminUserId: string,
    booking: BookingLike,
    kind: AdminAlertKind,
    body: string,
  ) {
    const titles: Record<typeof kind, string> = {
      admin_pickup_confirmed: "Package picked up",
      admin_delivery_confirmed: "Package delivered",
      admin_code_locked: "Handover code locked",
      admin_handover_flagged: "Check handover location",
    };
    return dispatch({
      userId: adminUserId,
      type: kind,
      title: titles[kind],
      body,
      href: `/admin/bookings/${booking.bookingReference}`,
      bookingId: String(booking._id),
      bookingReference: booking.bookingReference,
    });
  },
};

/** Fan a notification out to every admin account. Never throws. */
export async function notifyAllAdmins(
  booking: BookingLike,
  kind: AdminAlertKind,
  body: string,
): Promise<void> {
  try {
    await connectToDatabase();
    const admins = await User.find({ role: "admin" }).select("_id").lean();
    await Promise.all(admins.map((a) => notify.adminAlert(String(a._id), booking, kind, body)));
  } catch (err) {
    console.error("[notifications] adminAlert fan-out failed", err);
  }
}
