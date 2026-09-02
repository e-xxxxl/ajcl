import { Router } from "express";
import { z } from "zod";
import { ok, asyncHandler, parse, ApiError } from "../lib/api";
import { autocomplete, placeDetails } from "../lib/maps/service";
import { requireSession } from "../lib/auth/middleware";
import { enforceRateLimit } from "../lib/rate-limit";
import { env, isMapsServerConfigured } from "../lib/env";
import { MAPS_CONFIG } from "../config/maps";

export const mapsRouter = Router();

const autocompleteSchema = z.object({
  input: z.string().trim().min(1).max(200),
  sessionToken: z.string().trim().max(120).optional(),
});

const placeSchema = z.object({
  placeId: z.string().trim().min(3).max(300),
  sessionToken: z.string().trim().max(120).optional(),
});

/** POST /api/maps/autocomplete — server fallback (needs an unrestricted GOOGLE_MAPS_API_KEY). */
mapsRouter.post(
  "/autocomplete",
  asyncHandler(async (req, res) => {
    requireSession(req);
    enforceRateLimit(req, "maps-autocomplete", { limit: 120, windowMs: 60 * 1000 });

    const { input, sessionToken } = parse(autocompleteSchema, req.body);
    const { predictions, error } = await autocomplete(input, sessionToken);

    return ok(res, {
      predictions,
      configured: isMapsServerConfigured,
      error:
        error && !env.isProd
          ? error
          : error
            ? "Address search is unavailable right now."
            : undefined,
    });
  }),
);

/** POST /api/maps/place */
mapsRouter.post(
  "/place",
  asyncHandler(async (req, res) => {
    requireSession(req);
    enforceRateLimit(req, "maps-place", { limit: 60, windowMs: 60 * 1000 });

    const { placeId, sessionToken } = parse(placeSchema, req.body);
    const place = await placeDetails(placeId, sessionToken);
    if (!place) throw new ApiError("Could not resolve that place.", 404);

    return ok(res, { place });
  }),
);

/** GET /api/maps/config — non-secret defaults for the client. */
mapsRouter.get(
  "/config",
  asyncHandler(async (_req, res) =>
    ok(res, {
      autocompleteConfigured: isMapsServerConfigured,
      defaultCenter: MAPS_CONFIG.defaultCenter,
      defaultZoom: MAPS_CONFIG.defaultZoom,
    }),
  ),
);
