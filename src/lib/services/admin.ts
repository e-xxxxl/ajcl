import { connectToDatabase } from "../db";
import { Booking } from "../../models/Booking";
import { Payment } from "../../models/Payment";
import { User } from "../../models/User";

export type AdminStats = {
  totalBookings: number;
  pendingBookings: number;
  activeDeliveries: number;
  completedDeliveries: number;
  cancelledBookings: number;
  revenue: number;
  revenueThisMonth: number;
  customers: number;
  recentBookings: number;
};

export async function getAdminStats(): Promise<AdminStats> {
  await connectToDatabase();

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 86400_000);

  const [
    totalBookings,
    pendingBookings,
    activeDeliveries,
    completedDeliveries,
    cancelledBookings,
    customers,
    recentBookings,
    revenueAgg,
    revenueMonthAgg,
  ] = await Promise.all([
    Booking.countDocuments({}),
    Booking.countDocuments({ status: "pending" }),
    Booking.countDocuments({ status: { $in: ["confirmed", "driver_assigned", "in_transit"] } }),
    Booking.countDocuments({ status: "delivered" }),
    Booking.countDocuments({ status: "cancelled" }),
    User.countDocuments({ role: "customer" }),
    Booking.countDocuments({ createdAt: { $gte: weekAgo } }),
    Payment.aggregate<{ _id: null; total: number }>([
      { $match: { status: "success" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    Payment.aggregate<{ _id: null; total: number }>([
      { $match: { status: "success", paidAt: { $gte: startOfMonth } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
  ]);

  return {
    totalBookings,
    pendingBookings,
    activeDeliveries,
    completedDeliveries,
    cancelledBookings,
    revenue: revenueAgg[0]?.total ?? 0,
    revenueThisMonth: revenueMonthAgg[0]?.total ?? 0,
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
