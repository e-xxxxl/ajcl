import { Router } from "express";
import { connectToDatabase } from "../lib/db";
import { ok, asyncHandler, ApiError } from "../lib/api";
import { requireSession } from "../lib/auth/middleware";
import { User } from "../models/User";
import { getPartnerLedger } from "../lib/services/partner";
import { isActivePartner } from "../lib/services/partner-pricing";

export const partnerRouter = Router();

/** GET /api/partner/statement: the signed-in partner's own account (billed, paid, owing, orders). */
partnerRouter.get(
  "/statement",
  asyncHandler(async (req, res) => {
    const session = requireSession(req);
    await connectToDatabase();
    const user = await User.findById(session.sub).select("partner").lean();
    if (!user || !isActivePartner(user as { partner?: { active?: boolean | null } })) {
      throw new ApiError("This isn't a partner account.", 403);
    }
    return ok(res, { ledger: await getPartnerLedger(session.sub) });
  }),
);
