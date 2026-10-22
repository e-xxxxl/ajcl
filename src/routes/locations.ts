import { Router } from "express";
import { z } from "zod";
import { ok, asyncHandler, parse } from "../lib/api";
import { enforceRateLimit } from "../lib/rate-limit";
import { getCountries, getStates, getCities } from "../lib/services/locations";

/**
 * Countries, states and cities for the address forms. The browser asks us, we ask Terminal
 * Africa (the key never leaves the server), and answers are cached for 24 hours.
 */
export const locationsRouter = Router();

const iso = z.string().trim().toUpperCase().min(2).max(3);
const stateCode = z.string().trim().toUpperCase().min(1).max(10);

locationsRouter.get(
  "/countries",
  asyncHandler(async (req, res) => {
    enforceRateLimit(req, "locations", { limit: 120, windowMs: 60 * 1000 });
    const countries = await getCountries();
    res.setHeader("Cache-Control", "public, max-age=3600");
    return ok(res, { countries: countries.map((c) => ({ code: c.code, name: c.name, phonecode: c.phonecode ?? null })) });
  }),
);

locationsRouter.get(
  "/states",
  asyncHandler(async (req, res) => {
    enforceRateLimit(req, "locations", { limit: 120, windowMs: 60 * 1000 });
    const { country } = parse(z.object({ country: iso }), req.query);
    const states = await getStates(country);
    res.setHeader("Cache-Control", "public, max-age=3600");
    return ok(res, { states: states.map((s) => ({ code: s.code, name: s.name })) });
  }),
);

locationsRouter.get(
  "/cities",
  asyncHandler(async (req, res) => {
    enforceRateLimit(req, "locations", { limit: 120, windowMs: 60 * 1000 });
    const { country, state } = parse(z.object({ country: iso, state: stateCode }), req.query);
    const cities = await getCities(country, state);
    res.setHeader("Cache-Control", "public, max-age=3600");
    return ok(res, { cities: cities.map((c) => ({ name: c.name })) });
  }),
);
