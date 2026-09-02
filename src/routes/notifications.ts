import { Router } from "express";
import { z } from "zod";
import { connectToDatabase } from "../lib/db";
import { ok, asyncHandler, parse } from "../lib/api";
import { requireSession } from "../lib/auth/middleware";
import { Notification } from "../models/Notification";
import { serializeNotification } from "../lib/serialize";

export const notificationsRouter = Router();

const readSchema = z.object({
  id: z.string().trim().optional(),
  all: z.boolean().optional(),
});

/** GET /api/notifications?limit= — latest notifications + unread count. */
notificationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const session = requireSession(req);
    await connectToDatabase();

    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const [items, unread] = await Promise.all([
      Notification.find({ user: session.sub }).sort({ createdAt: -1 }).limit(limit).lean(),
      Notification.countDocuments({ user: session.sub, read: false }),
    ]);

    return ok(res, { notifications: items.map(serializeNotification), unread });
  }),
);

/** POST /api/notifications/read — mark one (id) or all as read. */
notificationsRouter.post(
  "/read",
  asyncHandler(async (req, res) => {
    const session = requireSession(req);
    await connectToDatabase();

    const { id, all } = parse(readSchema, req.body);
    const now = new Date();

    if (all) {
      await Notification.updateMany(
        { user: session.sub, read: false },
        { $set: { read: true, readAt: now } },
      );
    } else if (id) {
      await Notification.updateOne(
        { _id: id, user: session.sub },
        { $set: { read: true, readAt: now } },
      );
    }

    const unread = await Notification.countDocuments({ user: session.sub, read: false });
    return ok(res, { unread });
  }),
);
