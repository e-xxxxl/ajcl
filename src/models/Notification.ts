import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/** Notification event types — keep in sync with lib/notifications. */
export const NOTIFICATION_TYPES = [
  "booking_created",
  "payment_succeeded",
  "payment_failed",
  "booking_confirmed",
  "driver_assigned",
  "in_transit",
  "delivered",
  "booking_cancelled",
  "admin_new_booking",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

const notificationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: NOTIFICATION_TYPES as unknown as string[], required: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    body: { type: String, required: true, trim: true, maxlength: 600 },
    /** Deep link, e.g. /dashboard/bookings/AJC-XXXX. */
    href: { type: String, trim: true },
    booking: { type: Schema.Types.ObjectId, ref: "Booking", index: true },
    read: { type: Boolean, default: false, index: true },
    readAt: { type: Date },
    /** Channels this event was dispatched to (in-app is always first). */
    channels: { type: [String], default: ["in_app"] },
  },
  { timestamps: true },
);

notificationSchema.index({ user: 1, read: 1, createdAt: -1 });

notificationSchema.set("toJSON", {
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.__v;
    return ret;
  },
});

export type NotificationDoc = InferSchemaType<typeof notificationSchema> & { _id: string };

export const Notification: Model<NotificationDoc> =
  (models.Notification as Model<NotificationDoc>) ??
  model<NotificationDoc>("Notification", notificationSchema);
