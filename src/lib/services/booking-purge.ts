import { Booking } from "../../models/Booking";
import { HandoverProof } from "../../models/HandoverProof";
import { Notification } from "../../models/Notification";
import { Payment } from "../../models/Payment";
import { StatusHistory } from "../../models/StatusHistory";
import { deleteProofPhotos } from "./proof";

/** Remove bookings and everything that hangs off them: proofs, photos, payments (so the revenue goes too), history and notices. */
export async function hardDeleteBookings(filter: Record<string, unknown>): Promise<number> {
  const bookings = await Booking.find(filter).select("_id").lean();
  const ids = bookings.map((b) => b._id);
  if (ids.length === 0) return 0;
  await Promise.all([
    HandoverProof.deleteMany({ booking: { $in: ids } }),
    deleteProofPhotos({ booking: { $in: ids } }),
    Payment.deleteMany({ booking: { $in: ids } }),
    StatusHistory.deleteMany({ booking: { $in: ids } }),
    Notification.deleteMany({ booking: { $in: ids } }),
    Booking.deleteMany({ _id: { $in: ids } }),
  ]);
  return ids.length;
}
