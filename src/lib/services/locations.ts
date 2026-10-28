import { ApiError } from "../api";
import { terminal, type TerminalCountry, type TerminalState, type TerminalCity } from "../terminal/api";
import { TerminalError } from "../terminal/client";

/**
 * Countries, states and cities, straight from Terminal Africa and nothing else. There is no
 * built-in list to fall back on: if Terminal cannot be reached the caller gets a clear error.
 * Results are cached for 24 hours (countries, states, and cities per state), and identical
 * lookups made at the same moment share one request.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

type Entry<T> = { value: T; expires: number };
const cache = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Entry<T> | undefined;
  if (hit && hit.expires > Date.now()) return hit.value;
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const p = load()
    .then((value) => {
      cache.set(key, { value, expires: Date.now() + DAY_MS });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Test hook: forget everything cached. */
export function clearLocationCache() {
  cache.clear();
  inflight.clear();
}

function unavailable(err: unknown): never {
  if (err instanceof TerminalError) {
    console.error("[terminal] locations:", err.message);
    throw new ApiError(
      err.retryable ? "Location data is not available right now. Please try again in a moment." : "Location data could not be loaded. Please try again shortly.",
      err.retryable ? 503 : 502,
    );
  }
  throw err;
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
const clean = (s: string) => s.trim().toLowerCase();

export async function getCountries(): Promise<TerminalCountry[]> {
  try {
    return await cached("countries", async () => (await terminal().listCountries()).sort(byName));
  } catch (err) {
    return unavailable(err);
  }
}

/**
 * A phone number must start with the dial code of the country of its address; the carrier refuses it otherwise.
 * Throws a plain error naming whose number it is and which field to fix. If the country list is not available the
 * check is skipped (the carrier has the last word).
 */
export async function assertPhonesMatchCountry(parties: { who: "sender" | "receiver"; phone: string; country: string }[]): Promise<void> {
  let countries: TerminalCountry[];
  try {
    countries = await getCountries();
  } catch {
    return;
  }
  const details: Record<string, string[]> = {};
  let first = "";
  for (const p of parties) {
    const dial = (countries.find((c) => c.code === p.country.toUpperCase())?.phonecode ?? "").replace(/\D/g, "");
    const digits = p.phone.replace(/\D/g, "");
    if (!dial || !digits || digits.startsWith(dial) || (dial.startsWith("1") && digits.startsWith("1"))) continue;
    const name = countries.find((c) => c.code === p.country.toUpperCase())?.name ?? p.country;
    const whose = p.who === "sender" ? "The sender's" : "The receiver's";
    const text = `${whose} phone number does not match ${name}. It should start with +${dial}. Use a ${name} number, or change the country to where the number is from.`;
    details[`${p.who}.phone`] = [text];
    first ||= text;
  }
  if (first) throw new ApiError(first, 422, details);
}

export async function getStates(countryCode: string): Promise<TerminalState[]> {
  const code = countryCode.trim().toUpperCase();
  try {
    return await cached(`states:${code}`, async () => (await terminal().listStates(code)).sort(byName));
  } catch (err) {
    return unavailable(err);
  }
}

export async function getCities(countryCode: string, stateCode: string): Promise<TerminalCity[]> {
  const c = countryCode.trim().toUpperCase();
  const s = stateCode.trim().toUpperCase();
  try {
    return await cached(`cities:${c}:${s}`, async () => (await terminal().listCities(c, s)).sort(byName));
  } catch (err) {
    return unavailable(err);
  }
}

export type ResolvedLocation = {
  country: string;
  countryName: string;
  state: string;
  stateCode: string;
  city: string;
};

/**
 * Check a country / state / city against Terminal's own lists and return Terminal's exact
 * spelling. These values go straight into Terminal addresses, so a place Terminal does not
 * know is refused here rather than failing later when rates or bookings are requested.
 */
export async function resolveLocation(input: { country: string; state: string; city: string }, label = "address"): Promise<ResolvedLocation> {
  const countries = await getCountries();
  const country = countries.find((c) => c.code === input.country.trim().toUpperCase());
  if (!country) throw new ApiError(`The ${label} country is not one we can ship to.`, 422);

  const states = await getStates(country.code);
  const state = states.find((s) => clean(s.name) === clean(input.state) || s.code.toUpperCase() === input.state.trim().toUpperCase());
  if (!state) throw new ApiError(`"${input.state}" is not a recognised state or region in ${country.name} (${label}).`, 422);

  const cities = await getCities(country.code, state.code);
  let cityName = input.city.trim();
  if (cities.length > 0) {
    const city = cities.find((c) => clean(c.name) === clean(input.city));
    if (!city) throw new ApiError(`"${input.city}" is not a recognised city in ${state.name}, ${country.name} (${label}).`, 422);
    cityName = city.name;
  } else if (cityName.length < 2) {
    throw new ApiError(`Enter the city for the ${label}.`, 422);
  }
  return { country: country.code, countryName: country.name, state: state.name, stateCode: state.code, city: cityName };
}
