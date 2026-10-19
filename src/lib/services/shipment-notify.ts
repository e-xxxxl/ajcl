import { connectToDatabase } from "../db";
import { User } from "../../models/User";
import { dispatch } from "../notifications";
import type { NotificationType } from "../../models/Notification";

/**
 * Notifications for the shipping feature. Same channels as everything else: an in-app
 * notification plus an email through the existing Resend driver. There is no SMS.
 * None of these ever throw: a failed notification must not undo the work it reports.
 */

export function customerHref(reference: string) {
  return `/dashboard/shipments/${reference}`;
}
export function officeHref(reference: string) {
  return `/admin/shipments/${reference}`;
}

export async function notifyCustomer(
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
  reference: string,
) {
  try {
    await dispatch({ userId, type, title, body, href: customerHref(reference) });
  } catch (err) {
    console.error("[shipments] customer notification failed", err);
  }
}

async function adminIds(opts: { superOnly?: boolean; office?: boolean }): Promise<string[]> {
  await connectToDatabase();
  const filter: Record<string, unknown> = opts.superOnly
    ? { role: "admin", superAdmin: true }
    : { role: { $in: opts.office ? ["admin", "office_admin"] : ["admin"] } };
  const users = await User.find(filter as never).select("_id").lean();
  return users.map((u) => String(u._id));
}

/** Everyone who works the shipments desk: Office Admins and admins. */
export async function notifyOffice(type: NotificationType, title: string, body: string, reference: string) {
  try {
    const ids = await adminIds({ office: true });
    await Promise.all(ids.map((userId) => dispatch({ userId, type, title, body, href: officeHref(reference) })));
  } catch (err) {
    console.error("[shipments] office notification failed", err);
  }
}

export async function notifySuperAdmins(type: NotificationType, title: string, body: string, href: string) {
  try {
    const ids = await adminIds({ superOnly: true });
    await Promise.all(ids.map((userId) => dispatch({ userId, type, title, body, href })));
  } catch (err) {
    console.error("[shipments] super admin notification failed", err);
  }
}
