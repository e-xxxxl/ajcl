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
export { HandoverProof, type HandoverProofDoc } from "./HandoverProof";
export { ProofPhoto, type ProofPhotoDoc } from "./ProofPhoto";
export { PartnerPayment, type PartnerPaymentDoc } from "./PartnerPayment";
export { Shipment, type ShipmentDoc } from "./Shipment";
export { ShippingSettings, type ShippingSettingsDoc } from "./ShippingSettings";
export { SiteAsset, type SiteAssetDoc } from "./SiteAsset";
export { PriceList, type PriceListDoc } from "./PriceList";
export { SiteContent, type SiteContentDoc } from "./SiteContent";
