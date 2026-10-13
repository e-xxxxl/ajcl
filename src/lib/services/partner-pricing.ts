import { connectToDatabase } from "../db";
import { User } from "../../models/User";

type PartnerFields = {
  active?: boolean | null;
  company?: string | null;
  markupPercent?: number | null;
  creditLimit?: number | null;
} | null;

/** True when this user document is an active partner. */
export function isActivePartner(u: { partner?: PartnerFields } | null | undefined): boolean {
  return Boolean(u?.partner?.active);
}

/** What a partner is allowed to know about their own account (never the markup). */
export function partnerPublic(
  u: { partner?: PartnerFields } | null | undefined,
): { active: true; company?: string } | undefined {
  if (!u || !isActivePartner(u)) return undefined;
  return { active: true, company: u.partner?.company ?? undefined };
}

/**
 * The price markup (+) or discount (-) the admin set for this user, in percent.
 * 0 for anyone who isn't an active partner, so ordinary customers are never affected.
 */
export async function getPartnerMarkup(userId: string): Promise<number> {
  await connectToDatabase();
  const u = await User.findById(userId).select("partner").lean();
  if (!u || !isActivePartner(u as { partner?: PartnerFields })) return 0;
  const m = (u as { partner?: PartnerFields }).partner?.markupPercent;
  return typeof m === "number" && Number.isFinite(m) ? m : 0;
}
