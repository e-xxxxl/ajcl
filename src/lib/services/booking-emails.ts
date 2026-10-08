import { Booking, type BookingHydrated } from "../../models/Booking";
import { User } from "../../models/User";
import { isEmailConfigured } from "../env";
import { sendEmail } from "../email/send";
import { qrInlineImage } from "../email/qr";
import {
  senderConfirmationEmail,
  receiverConfirmationEmail,
  senderRiderAssignedEmail,
  receiverRiderAssignedEmail,
} from "../email/handover-templates";

function scheduledLabel(at: Date | string | undefined, fallbackDate: string, fallbackTime: string): string {
  if (!at) return `${fallbackDate} ${fallbackTime}`;
  return new Date(at).toLocaleString("en-NG", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Lagos",
  });
}

/** Everywhere the sender can be reached: their account email and the contact email on the booking. */
async function senderAddresses(booking: {
  user: unknown;
  sender?: { email?: string | null } | null;
}): Promise<string[]> {
  const out = new Set<string>();
  const user = await User.findById(booking.user).select("email").lean();
  if (user?.email) out.add(user.email.toLowerCase());
  if (booking.sender?.email) out.add(booking.sender.email.toLowerCase());
  return [...out];
}

/**
 * Once a booking is paid and confirmed: email the sender their pickup code and
 * the receiver their delivery code, each with a QR, the steps, and a warning to
 * keep it private until the rider is physically there. Sent at most once per
 * booking. Never throws.
 */
export async function sendConfirmationEmails(booking: BookingHydrated): Promise<void> {
  if (!isEmailConfigured) return;
  try {
    const claim = await Booking.updateOne(
      { _id: booking._id, "handover.codesEmailedAt": { $exists: false } },
      { $set: { "handover.codesEmailedAt": new Date() } },
    );
    if (claim.modifiedCount === 0) return;

    const b = await Booking.findById(booking._id)
      .select("+handover.pickupCode +handover.deliveryCode +handover.trackingToken")
      .lean();
    const pickupCode = b?.handover?.pickupCode;
    const deliveryCode = b?.handover?.deliveryCode;
    const trackingToken = b?.handover?.trackingToken;
    if (!b || !pickupCode || !deliveryCode || !trackingToken) return;

    const when = scheduledLabel(b.scheduledAt, b.scheduledDate, b.scheduledTime);

    // Sender
    const [senderQr, senderTo] = await Promise.all([
      qrInlineImage(pickupCode, "pickup-qr"),
      senderAddresses(b),
    ]);
    const senderMail = senderConfirmationEmail({
      name: b.sender?.name,
      ref: b.bookingReference,
      pickupAddress: b.pickup.formattedAddress,
      destinationAddress: b.destination.formattedAddress,
      scheduledLabel: when,
      vehicleName: b.vehicle?.name ?? "",
      pickupCode,
      qrCid: senderQr?.contentId,
    });
    for (const to of senderTo) {
      await sendEmail({ to, ...senderMail, inlineImages: senderQr ? [senderQr] : undefined });
    }

    // Receiver
    if (b.recipient?.email) {
      const receiverQr = await qrInlineImage(deliveryCode, "delivery-qr");
      const receiverMail = receiverConfirmationEmail({
        name: b.recipient.name,
        ref: b.bookingReference,
        senderName: b.sender?.name || "Someone",
        pickupAddress: b.pickup.formattedAddress,
        destinationAddress: b.destination.formattedAddress,
        scheduledLabel: when,
        deliveryCode,
        qrCid: receiverQr?.contentId,
        trackingToken,
      });
      await sendEmail({
        to: b.recipient.email,
        ...receiverMail,
        inlineImages: receiverQr ? [receiverQr] : undefined,
      });
    }
  } catch (err) {
    console.error("[booking-emails] confirmation emails failed", err instanceof Error ? err.message : err);
  }
}

/**
 * When a rider is assigned (or swapped): tell the sender and the receiver who is
 * coming, with the rider's name, phone and plate number. Never throws.
 */
export async function sendRiderAssignedEmails(bookingId: unknown): Promise<void> {
  if (!isEmailConfigured) return;
  try {
    const b = await Booking.findById(bookingId).select("+handover.trackingToken").lean();
    const d = b?.assignedDriver;
    if (!b || !d || (!d.name && !d.phone && !d.plate)) return;

    const rider = { name: d.name ?? undefined, phone: d.phone ?? undefined, plate: d.plate ?? undefined };
    const when = scheduledLabel(b.scheduledAt, b.scheduledDate, b.scheduledTime);

    const senderMail = senderRiderAssignedEmail({
      name: b.sender?.name,
      ref: b.bookingReference,
      rider,
      scheduledLabel: when,
    });
    for (const to of await senderAddresses(b)) {
      await sendEmail({ to, ...senderMail });
    }

    const token = b.handover?.trackingToken;
    if (b.recipient?.email && token) {
      const receiverMail = receiverRiderAssignedEmail({
        name: b.recipient.name,
        ref: b.bookingReference,
        rider,
        scheduledLabel: when,
        trackingToken: token,
      });
      await sendEmail({ to: b.recipient.email, ...receiverMail });
    }
  } catch (err) {
    console.error("[booking-emails] rider-assigned emails failed", err instanceof Error ? err.message : err);
  }
}
