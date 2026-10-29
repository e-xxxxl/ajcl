import { connectToDatabase } from "../db";
import { Booking } from "../../models/Booking";
import { Payment } from "../../models/Payment";
import { RevenueReset } from "../../models/RevenueReset";
import { User } from "../../models/User";
import { partnerOutstandingTotals } from "./partner";

export type AdminStats = {
  totalBookings: number;
  pendingBookings: number;
  activeDeliveries: number;
  completedDeliveries: number;
  cancelledBookings: number;
  returnedBookings: number;
  /** Total owed by partners, and how many partners owe something. */
  partnerOutstanding: number;
  partnersOwing: number;
  revenue: number;
  revenueThisMonth: number;
  /** When revenue was last cleared, and what it stood at then. Totals above count only what was paid after this. */
  revenueClearedAt?: string;
  revenueClearedTotal?: number;
  customers: number;
  recentBookings: number;
};

/** When a payment counted: the day it was paid (or, if that was never recorded, when it was started). */
const PAID_WHEN = { $ifNull: ["$paidAt", "$createdAt"] };

async function revenueTotal(since?: Date | null): Promise<number> {
  const agg = await Payment.aggregate<{ _id: null; total: number }>([
    { $match: { status: "success", ...(since ? { $expr: { $gte: [PAID_WHEN, since] } } : {}) } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  return agg[0]?.total ?? 0;
}

/** Clear revenue: the totals start again from now. Payment records are kept. */
export async function resetRevenue(byName: string): Promise<{ clearedTotal: number; at: Date }> {
  await connectToDatabase();
  const previous = await RevenueReset.findOne({ key: "revenue" }).lean();
  const clearedTotal = await revenueTotal(previous?.at);
  const at = new Date();
  await RevenueReset.findOneAndUpdate({ key: "revenue" }, { $set: { at, clearedTotal, byName } }, { upsert: true });
  return { clearedTotal, at };
}

export async function getAdminStats(): Promise<AdminStats> {
  await connectToDatabase();

  const cleared = await RevenueReset.findOne({ key: "revenue" }).lean();
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const monthFrom = cleared && cleared.at > startOfMonth ? cleared.at : startOfMonth;
  const weekAgo = new Date(Date.now() - 7 * 86400_000);

  const [
    totalBookings,
    pendingBookings,
    activeDeliveries,
    completedDeliveries,
    cancelledBookings,
    returnedBookings,
    customers,
    recentBookings,
    revenueAgg,
    revenueMonthAgg,
    partnerTotals,
  ] = await Promise.all([
    Booking.countDocuments({}),
    Booking.countDocuments({ status: "pending" }),
    Booking.countDocuments({ status: { $in: ["confirmed", "driver_assigned", "in_transit"] } }),
    Booking.countDocuments({ status: "delivered" }),
    Booking.countDocuments({ status: "cancelled" }),
    Booking.countDocuments({ status: "returned" }),
    User.countDocuments({ role: "customer" }),
    Booking.countDocuments({ createdAt: { $gte: weekAgo } }),
    revenueTotal(cleared?.at),
    revenueTotal(monthFrom),
    partnerOutstandingTotals(),
  ]);

  return {
    totalBookings,
    pendingBookings,
    activeDeliveries,
    completedDeliveries,
    cancelledBookings,
    returnedBookings,
    partnerOutstanding: partnerTotals.outstanding,
    partnersOwing: partnerTotals.partnersOwing,
    revenue: revenueAgg,
    revenueThisMonth: revenueMonthAgg,
    revenueClearedAt: cleared ? new Date(cleared.at).toISOString() : undefined,
    revenueClearedTotal: cleared ? cleared.clearedTotal : undefined,
    customers,
    recentBookings,
  };
}

export type BookingFilter = {
  status?: string;
  paymentStatus?: string;
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

export async function listBookingsForAdmin(filter: BookingFilter) {
  await connectToDatabase();

  const query: Record<string, unknown> = {};
  if (filter.status && filter.status !== "all") query.status = filter.status;
  if (filter.paymentStatus && filter.paymentStatus !== "all") {
    query["payment.status"] = filter.paymentStatus;
  }
  if (filter.from || filter.to) {
    const range: Record<string, Date> = {};
    if (filter.from) range.$gte = new Date(`${filter.from}T00:00:00`);
    if (filter.to) range.$lte = new Date(`${filter.to}T23:59:59`);
    query.createdAt = range;
  }

  if (filter.search) {
    const term = filter.search.trim();
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const matchingUsers = await User.find({
      $or: [{ firstName: rx }, { lastName: rx }, { email: rx }, { phone: rx }],
    })
      .select("_id")
      .lean();
    query.$or = [
      { bookingReference: rx },
      { "recipient.name": rx },
      { "sender.name": rx },
      { user: { $in: matchingUsers.map((u) => u._id) } },
    ];
  }

  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(Math.max(5, filter.pageSize ?? 20), 100);

  const [items, total] = await Promise.all([
    Booking.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate("user", "firstName lastName email phone")
      .lean(),
    Booking.countDocuments(query),
  ]);

  return { items, total, page, pageSize, pages: Math.ceil(total / pageSize) };
}
