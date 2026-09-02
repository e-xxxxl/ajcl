/** Barrel that also guarantees every model is registered on the connection. */
export { User, type UserDoc } from "./User";
export { Vehicle, type VehicleDoc } from "./Vehicle";
export { Booking, type BookingDoc, type BookingLocation } from "./Booking";
export {
  Notification,
  type NotificationDoc,
  type NotificationType,
  NOTIFICATION_TYPES,
} from "./Notification";
export { Payment, type PaymentDoc } from "./Payment";
export { StatusHistory, type StatusHistoryDoc } from "./StatusHistory";
