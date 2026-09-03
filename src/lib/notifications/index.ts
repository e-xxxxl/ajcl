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
  async statusChanged(userId: string, booking: BookingLike, status: string) {
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
    };
    const t = map[status];
    if (!t) return;
    const d = booking.assignedDriver;
    return dispatch({
      userId,
      type: t.type,
      title: t.title,
      body: t.body,
      href: bookingHref(booking.bookingReference),
      bookingId: String(booking._id),
      bookingReference: booking.bookingReference,
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
  async adminNewBooking(adminUserId: string, booking: BookingLike) {
    return dispatch({
      userId: adminUserId,
      type: "admin_new_booking",
      title: "New paid booking",
      body: `${booking.bookingReference} has been paid and needs a rider.`,
      href: `/admin/bookings/${booking.bookingReference}`,
      bookingId: String(booking._id),
      bookingReference: booking.bookingReference,
    });
  },
};
