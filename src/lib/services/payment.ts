import { connectToDatabase } from "../db";
import { Booking, type BookingHydrated } from "../../models/Booking";
import { Payment } from "../../models/Payment";
import { Vehicle } from "../../models/Vehicle";
import { User } from "../../models/User";
import { ApiError } from "../api";
import { env } from "../env";
import { calculatePrice, toMinorUnits } from "../pricing/engine";
import { computeRouteMetrics, bookingToRouteInput } from "./quote";
import { changeBookingStatus } from "./booking";
import { isClassSoldOut } from "./fleet";
import { notify } from "../notifications";
import { ensureHandoverCodes } from "./handover";
import { sendConfirmationEmails } from "./booking-emails";
import { autoAssignBooking } from "./autoassign";
import {
  initializeTransaction,
  verifyTransaction,
  type PaystackVerifyResult,
} from "../paystack";

/**
 * Re-price a booking from scratch (route + vehicle rate) and persist the fresh
 * breakdown. This is the authoritative amount charged — the client total is
 * never trusted.
 */
export async function repriceBooking(booking: BookingHydrated): Promise<BookingHydrated> {
  const vehicle = await Vehicle.findById(booking.vehicle?.vehicleId);
  if (!vehicle) throw new ApiError("The vehicle for this booking is no longer available.", 409);

  const rm = booking.routeMeta;
  const metrics = await computeRouteMetrics(bookingToRouteInput(booking), {
    stored:
      rm && rm.distanceKm && rm.distanceKm > 0
        ? {
            distanceKm: rm.distanceKm,
            returnLegKm: rm.returnLegKm ?? 0,
            durationSeconds: rm.estimatedDurationSeconds ?? 0,
            polyline: booking.routePolyline ?? undefined,
          }
        : undefined,
  });

  if (metrics.distanceKm > 0) {
    const pricing = calculatePrice(
      {
        slug: vehicle.slug,
        name: vehicle.name,
        pricePerKm: vehicle.pricePerKm,
        basePrice: vehicle.basePrice,
        minimumFare: vehicle.minimumFare,
      },
      {
        distanceKm: metrics.distanceKm,
        returnLegKm: metrics.returnLegKm,
        stopCount: metrics.stopCount,
        estimatedDurationSeconds: metrics.estimatedDurationSeconds,
      },
    );
    booking.distanceKm = metrics.distanceKm;
    booking.estimatedDurationSeconds = metrics.estimatedDurationSeconds;
    if (metrics.polyline) booking.routePolyline = metrics.polyline;
    booking.pricing = { ...pricing, computedAt: new Date() } as BookingHydrated["pricing"];
    if (booking.vehicle) booking.vehicle.pricePerKm = vehicle.pricePerKm;
    booking.payment.amount = pricing.total;
    await booking.save();
  }

  return booking;
}

/** Start (or resume) checkout for a booking. Returns a Paystack authorization URL. */
export async function initializeBookingPayment(
  userId: string,
  reference: string,
): Promise<{ authorizationUrl: string; reference: string; amount: number }> {
  await connectToDatabase();

  const booking = await Booking.findOne({ bookingReference: reference.toUpperCase() });
  if (!booking || String(booking.user) !== userId) {
    throw new ApiError("Booking not found.", 404);
  }
  if (booking.payment?.status === "paid") {
    throw new ApiError("This booking has already been paid.", 409);
  }
  if (booking.status === "cancelled") {
    throw new ApiError("This booking was cancelled.", 409);
  }

  // Don't take payment for a class that filled up since the booking was created.
  const vehicleDoc = booking.vehicle?.vehicleId
    ? await Vehicle.findById(booking.vehicle.vehicleId).lean()
    : null;
  if (
    vehicleDoc &&
    booking.vehicle &&
    (await isClassSoldOut(booking.vehicle.slug, vehicleDoc.fleetSize, {
      excludeBookingId: String(booking._id),
    }))
  ) {
    throw new ApiError(
      `All ${booking.vehicle.name.toLowerCase()}s are currently booked. Please try again shortly, or contact support to switch vehicles.`,
      409,
    );
  }

  // Authoritative re-price before charging.
  await repriceBooking(booking);

  const amount = booking.pricing.total;
  if (!amount || amount <= 0) {
    throw new ApiError("This booking has no payable amount. Please contact support.", 422);
  }

  const user = await User.findById(userId).lean();
  if (!user) throw new ApiError("Account not found.", 404);

  if (!env.paystackSecretKey) {
    throw new ApiError("Payments are not configured. Please contact support.", 503);
  }

  const txReference = `${booking.bookingReference}-${Date.now().toString(36).toUpperCase()}`;
  const amountMinor = toMinorUnits(amount);

  const init = await initializeTransaction({
    email: user.email,
    amountMinor,
    reference: txReference,
    currency: booking.pricing.currency,
    callbackUrl: `${env.frontendUrl}/book/payment/callback?ref=${booking.bookingReference}`,
    metadata: {
      bookingReference: booking.bookingReference,
      bookingId: String(booking._id),
      userId,
      custom_fields: [
        {
          display_name: "Booking",
          variable_name: "booking_reference",
          value: booking.bookingReference,
        },
      ],
    },
  });

  booking.payment.provider = "paystack";
  booking.payment.status = "pending";
  booking.payment.reference = init.reference;
  booking.payment.accessCode = init.accessCode;
  booking.payment.authorizationUrl = init.authorizationUrl;
  booking.payment.amount = amount;
  booking.payment.currency = booking.pricing.currency;
  await booking.save();

  await Payment.create({
    booking: booking._id,
    user: userId,
    reference: init.reference,
    accessCode: init.accessCode,
    amount,
    amountMinor,
    currency: booking.pricing.currency,
    status: "initialized",
  });

  return {
    authorizationUrl: init.authorizationUrl,
    reference: init.reference,
    amount,
  };
}

type ReconcileOutcome = {
  booking: BookingHydrated;
  paid: boolean;
  status: string;
};

/**
 * Apply a verification result to a booking. Idempotent — safe to call from both
 * the callback and the webhook. Only marks paid when the gateway says success
 * AND the amount matches the (re-priced) booking total.
 */
export async function reconcilePayment(
  verification: PaystackVerifyResult,
  via: "callback" | "webhook",
): Promise<ReconcileOutcome> {
  await connectToDatabase();

  const ledger = await Payment.findOne({ reference: verification.reference });
  const booking = ledger
    ? await Booking.findById(ledger.booking)
    : await Booking.findOne({ "payment.reference": verification.reference });

  if (!booking) throw new ApiError("Unknown payment reference.", 404);

  if (booking.payment?.status === "paid") {
    return { booking, paid: true, status: "paid" };
  }

  const expectedMinor = toMinorUnits(booking.pricing.total);
  const amountOk = verification.amountMinor >= expectedMinor;
  const success = verification.status === "success" && amountOk;

  if (ledger) {
    ledger.status = success ? "success" : verification.status === "pending" ? "pending" : "failed";
    ledger.channel = verification.channel;
    ledger.verifiedVia = via;
    ledger.gatewayResponse = verification.gatewayResponse;
    ledger.paidAt = verification.paidAt ? new Date(verification.paidAt) : undefined;
    ledger.set("raw", verification.raw);
    if (!amountOk && verification.status === "success") {
      ledger.gatewayResponse = `Amount mismatch: paid ${verification.amountMinor}, expected ${expectedMinor}`;
    }
    await ledger.save();
  }

  if (success) {
    booking.payment.status = "paid";
    booking.payment.channel = verification.channel;
    booking.payment.paidAt = verification.paidAt ? new Date(verification.paidAt) : new Date();
    booking.payment.amount = booking.pricing.total;
    booking.set("payment.rawVerification", verification.raw);
    await booking.save();

    await ensureHandoverCodes(booking);
    await notify.paymentSucceeded(String(booking.user), booking);

    let finalBooking: BookingHydrated = booking;
    const justConfirmed = booking.status === "pending";
    if (justConfirmed) {
      finalBooking = await changeBookingStatus({
        bookingId: String(booking._id),
        to: "confirmed",
        note: "Payment received",
        actorRole: "system",
      });
    }

    // Paid and confirmed: email the sender and receiver their codes (once only).
    await sendConfirmationEmails(finalBooking);

    // Then allocate a rider automatically. The rider-assigned emails follow the
    // confirmation emails, so the code always arrives first.
    const assigned = await autoAssignBooking(String(finalBooking._id));
    if (assigned) finalBooking = assigned;

    if (justConfirmed) await notifyAdmins(finalBooking, assigned?.assignedDriver?.name ?? undefined);

    return { booking: finalBooking, paid: true, status: "paid" };
  }

  if (verification.status !== "pending") {
    booking.payment.status = "failed";
    await booking.save();
    await notify.paymentFailed(String(booking.user), booking);
  }

  return { booking, paid: false, status: booking.payment.status };
}

async function notifyAdmins(booking: BookingHydrated, autoAssignedTo?: string) {
  try {
    const admins = await User.find({ role: "admin" }).select("_id").lean();
    await Promise.all(
      admins.map((a) => notify.adminNewBooking(String(a._id), booking, autoAssignedTo)),
    );
  } catch (err) {
    console.error("[payment] admin notify failed", err);
  }
}

/** Verify with Paystack and reconcile. Used by the callback route. */
export async function verifyAndReconcile(
  reference: string,
  via: "callback" | "webhook" = "callback",
): Promise<ReconcileOutcome> {
  if (!env.paystackSecretKey) {
    throw new ApiError("Payments are not configured. Please contact support.", 503);
  }

  const verification = await verifyTransaction(reference);
  return reconcilePayment(verification, via);
}
