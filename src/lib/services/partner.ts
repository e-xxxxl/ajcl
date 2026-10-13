import { Types } from "mongoose";
import { connectToDatabase } from "../db";
import { ApiError } from "../api";
import { Booking, type BookingHydrated } from "../../models/Booking";
import { Vehicle } from "../../models/Vehicle";
import { User } from "../../models/User";
import { PartnerPayment } from "../../models/PartnerPayment";
import { isClassSoldOut } from "./fleet";
import { repriceBooking } from "./payment";
import { activateOrder } from "./activation";
import { isActivePartner } from "./partner-pricing";
import type { PartnerLedgerDTO } from "../../types";

const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A partner's account.
 *
 * Billed   = totals of their orders placed on account (cancelled orders excluded).
 * Paid     = payments the admin has recorded.
 * Outstanding = billed - paid.
 *
 * Payments are applied to the oldest orders first, which gives each order a "settled"
 * state without anyone having to allocate money by hand.
 */
export async function getPartnerLedger(partnerId: string): Promise<PartnerLedgerDTO> {
  await connectToDatabase();

  const [orders, payments, user] = await Promise.all([
    Booking.find({
      user: partnerId,
      "payment.status": "on_account",
      status: { $ne: "cancelled" },
    })
      .sort({ createdAt: 1 })
      .select("bookingReference createdAt scheduledDate status pricing.total pickup.formattedAddress destination.formattedAddress")
      .lean(),
    PartnerPayment.find({ partner: partnerId }).sort({ receivedAt: -1, createdAt: -1 }).lean(),
    User.findById(partnerId).select("partner").lean(),
  ]);

  const billed = round2(orders.reduce((sum, o) => sum + (o.pricing?.total ?? 0), 0));
  const paid = round2(payments.reduce((sum, p) => sum + p.amount, 0));

  let remaining = paid;
  const ledgerOrders = orders.map((o) => {
    const total = o.pricing?.total ?? 0;
    const allocated = round2(Math.min(total, Math.max(0, remaining)));
    remaining = round2(remaining - allocated);
    return {
      reference: o.bookingReference,
      createdAt: new Date(o.createdAt as unknown as string).toISOString(),
      status: o.status,
      total,
      allocated,
      settled: total > 0 ? allocated >= total : true,
      pickup: o.pickup?.formattedAddress ?? "",
      destination: o.destination?.formattedAddress ?? "",
    };
  });

  const outstanding = round2(billed - paid);
  const limit = (user as { partner?: { creditLimit?: number | null } } | null)?.partner?.creditLimit ?? null;

  return {
    billed,
    paid,
    outstanding: Math.max(0, outstanding),
    credit: Math.max(0, -outstanding),
    creditLimit: limit,
    availableCredit: limit ? Math.max(0, round2(limit - Math.max(0, outstanding))) : null,
    orders: ledgerOrders,
    payments: payments.map((p) => ({
      id: String(p._id),
      amount: p.amount,
      method: p.method as PartnerLedgerDTO["payments"][number]["method"],
      reference: p.reference ?? undefined,
      note: p.note ?? undefined,
      receivedAt: new Date(p.receivedAt).toISOString(),
      recordedByName: p.recordedByName ?? undefined,
    })),
  };
}

/** Total owed across every partner, for the admin overview. */
export async function partnerOutstandingTotals(): Promise<{ outstanding: number; partnersOwing: number }> {
  await connectToDatabase();
  const [billedRows, paidRows] = await Promise.all([
    Booking.aggregate<{ _id: unknown; total: number }>([
      { $match: { "payment.status": "on_account", status: { $ne: "cancelled" } } },
      { $group: { _id: "$user", total: { $sum: "$pricing.total" } } },
    ]),
    PartnerPayment.aggregate<{ _id: unknown; total: number }>([
      { $group: { _id: "$partner", total: { $sum: "$amount" } } },
    ]),
  ]);
  const paid = new Map(paidRows.map((r) => [String(r._id), r.total]));
  let outstanding = 0;
  let partnersOwing = 0;
  for (const r of billedRows) {
    const owed = r.total - (paid.get(String(r._id)) ?? 0);
    if (owed > 0.009) {
      outstanding += owed;
      partnersOwing += 1;
    }
  }
  return { outstanding: round2(outstanding), partnersOwing };
}

/**
 * A partner places an order without paying. The order is billed to their account (subject
 * to their credit limit) and then goes through exactly like a paid one: codes, confirmation
 * emails, automatic rider allocation.
 */
export async function placeOrderOnAccount(userId: string, reference: string): Promise<BookingHydrated> {
  await connectToDatabase();

  const owner = await User.findById(userId).select("partner").lean();
  if (!owner || !isActivePartner(owner as { partner?: { active?: boolean | null } })) {
    throw new ApiError("This isn't a partner account.", 403);
  }

  const booking = await Booking.findOne({ bookingReference: reference.toUpperCase() });
  if (!booking || String(booking.user) !== userId) throw new ApiError("Booking not found.", 404);
  if (booking.payment?.status === "on_account") {
    throw new ApiError("This order has already been placed on your account.", 409);
  }
  if (booking.status !== "pending" || !["unpaid", "pending", "failed"].includes(booking.payment?.status ?? "unpaid")) {
    throw new ApiError("This order can't be placed any more.", 409);
  }

  // Same rule as paying online: don't confirm a class that filled up in the meantime.
  const vehicleDoc = booking.vehicle?.vehicleId ? await Vehicle.findById(booking.vehicle.vehicleId).lean() : null;
  if (
    vehicleDoc &&
    booking.vehicle &&
    (await isClassSoldOut(booking.vehicle.slug, vehicleDoc.fleetSize, { excludeBookingId: String(booking._id) }))
  ) {
    throw new ApiError(
      `All ${booking.vehicle.name.toLowerCase()}s are currently booked. Please try again shortly, or contact support to switch vehicles.`,
      409,
    );
  }

  // Authoritative re-price (includes this partner's markup) before it goes on the account.
  await repriceBooking(booking);
  const amount = booking.pricing.total;
  if (!amount || amount <= 0) throw new ApiError("This order has no billable amount. Please contact support.", 422);

  const ledger = await getPartnerLedger(userId);
  const limit = ledger.creditLimit;
  if (limit && ledger.outstanding + amount > limit) {
    throw new ApiError(
      `Placing this order would take your account over its credit limit of ${naira(limit)} (you currently owe ${naira(ledger.outstanding)}). Please settle part of your balance first.`,
      409,
    );
  }

  // Claim it atomically so a double tap can't bill the same order twice.
  const claim = await Booking.updateOne(
    {
      _id: String(booking._id),
      status: "pending",
      "payment.status": { $in: ["unpaid", "pending", "failed"] },
    },
    {
      $set: {
        "payment.status": "on_account",
        "payment.provider": "account",
        "payment.amount": amount,
        "payment.currency": booking.pricing.currency,
      },
    },
  );
  if (claim.modifiedCount === 0) throw new ApiError("This order has already been placed.", 409);

  const fresh = await Booking.findById(booking._id);
  if (!fresh) throw new ApiError("Booking not found.", 404);
  return activateOrder(fresh, { onAccount: true });
}

/** Billed / paid / order count for a set of partners, in two queries. */
export async function partnerBalances(
  partnerIds: string[],
): Promise<Map<string, { billed: number; paid: number; orderCount: number }>> {
  await connectToDatabase();
  const out = new Map<string, { billed: number; paid: number; orderCount: number }>();
  if (partnerIds.length === 0) return out;
  const [billedRows, paidRows] = await Promise.all([
    Booking.aggregate<{ _id: unknown; total: number; count: number }>([
      { $match: { user: { $in: partnerIds.map((id) => new Types.ObjectId(id)) }, "payment.status": "on_account", status: { $ne: "cancelled" } } },
      { $group: { _id: "$user", total: { $sum: "$pricing.total" }, count: { $sum: 1 } } },
    ]),
    PartnerPayment.aggregate<{ _id: unknown; total: number }>([
      { $match: { partner: { $in: partnerIds.map((id) => new Types.ObjectId(id)) } } },
      { $group: { _id: "$partner", total: { $sum: "$amount" } } },
    ]),
  ]);
  for (const id of partnerIds) out.set(id, { billed: 0, paid: 0, orderCount: 0 });
  for (const r of billedRows) {
    const row = out.get(String(r._id));
    if (row) {
      row.billed = round2(r.total);
      row.orderCount = r.count;
    }
  }
  for (const r of paidRows) {
    const row = out.get(String(r._id));
    if (row) row.paid = round2(r.total);
  }
  return out;
}
