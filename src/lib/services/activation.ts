import type { BookingHydrated } from "../../models/Booking";
import { User } from "../../models/User";
import { connectToDatabase } from "../db";
import { notify } from "../notifications";
import { changeBookingStatus } from "./booking";
import { ensureHandoverCodes } from "./handover";
import { sendConfirmationEmails } from "./booking-emails";
import { autoAssignBooking } from "./autoassign";

/**
 * Everything that happens once an order is funded: by an online payment, or (for
 * partners) by being placed on their account. Both take the same path, so a partner's
 * order goes through exactly like a paid one:
 *
 *   handover codes -> status "confirmed" -> confirmation emails (code + QR)
 *   -> automatic rider allocation -> admin alert
 *
 * Safe to call more than once for the same booking (each step is idempotent).
 */
export async function activateOrder(
  booking: BookingHydrated,
  opts: { onAccount: boolean },
): Promise<BookingHydrated> {
  await ensureHandoverCodes(booking);
  // A paid customer gets a "payment received" notification. A partner is told their order
  // is confirmed by the status change below, with nothing about paying.
  if (!opts.onAccount) await notify.paymentSucceeded(String(booking.user), booking);

  let finalBooking: BookingHydrated = booking;
  const justConfirmed = booking.status === "pending";
  if (justConfirmed) {
    finalBooking = await changeBookingStatus({
      bookingId: String(booking._id),
      to: "confirmed",
      note: opts.onAccount ? "Order placed on partner account" : "Payment received",
      actorRole: "system",
    });
  }

  // Funded and confirmed: email the sender and receiver their codes (once only).
  await sendConfirmationEmails(finalBooking, { onAccount: opts.onAccount });

  // Then allocate a rider automatically. The rider-assigned emails follow the
  // confirmation emails, so the code always arrives first.
  const assigned = await autoAssignBooking(String(finalBooking._id));
  if (assigned) finalBooking = assigned;

  if (finalBooking.kind === "shipment_pickup") {
    const { onPickupFunded } = await import("./shipments");
    await onPickupFunded(finalBooking);
  }

  if (justConfirmed) {
    await notifyAdminsOfNewOrder(finalBooking, {
      onAccount: opts.onAccount,
      riderName: assigned?.assignedDriver?.name ?? undefined,
    });
  }
  return finalBooking;
}

async function notifyAdminsOfNewOrder(
  booking: BookingHydrated,
  opts: { onAccount: boolean; riderName?: string },
) {
  try {
    await connectToDatabase();
    let partnerName: string | undefined;
    if (opts.onAccount) {
      const owner = await User.findById(booking.user).select("firstName lastName partner").lean();
      partnerName =
        (owner as { partner?: { company?: string | null } } | null)?.partner?.company ||
        (owner ? `${owner.firstName} ${owner.lastName}`.trim() : undefined);
    }
    const admins = await User.find({ role: "admin" }).select("_id").lean();
    await Promise.all(
      admins.map((a) =>
        notify.adminNewBooking(String(a._id), booking, {
          riderName: opts.riderName,
          partnerName,
          total: opts.onAccount ? booking.pricing?.total : undefined,
        }),
      ),
    );
  } catch (err) {
    console.error("[activation] admin notify failed", err);
  }
}
