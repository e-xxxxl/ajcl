import { connectToDatabase } from "../db";
import { Booking } from "../../models/Booking";
import { serializeBooking } from "../serialize";
import type { BookingDTO } from "../../types";

export async function getMyBookings(userId: string): Promise<BookingDTO[]> {
  await connectToDatabase();
  const bookings = await Booking.find({ user: userId }).sort({ createdAt: -1 }).limit(200).lean();
  return bookings.map((b) => serializeBooking(b));
}

export async function getMyBooking(
  userId: string,
  reference: string,
): Promise<BookingDTO | null> {
  await connectToDatabase();
  const booking = await Booking.findOne({ bookingReference: reference.toUpperCase() }).lean();
  if (!booking || String(booking.user) !== userId) return null;
  return serializeBooking(booking);
}

export function bucketBookings(bookings: BookingDTO[]) {
  return {
    active: bookings.filter((b) =>
      ["confirmed", "driver_assigned", "in_transit"].includes(b.status),
    ),
    pending: bookings.filter((b) => b.status === "pending"),
    completed: bookings.filter((b) => b.status === "delivered"),
    cancelled: bookings.filter((b) => b.status === "cancelled"),
  };
}
