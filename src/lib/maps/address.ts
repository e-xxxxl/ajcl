/**
 * Turns Google's address data into something a rider can act on.
 *
 * Google sometimes returns only a "plus code" as the formatted address
 * (e.g. "Q3F2+HX Lagos"), which tells a rider nothing at the door. We keep the
 * structured parts (place name, street, area, city, state) and rebuild a readable
 * address from them when that happens.
 */

export type AddressComponent = { longText: string; types: string[] };

export type AddressParts = {
  formattedAddress: string;
  name?: string;
  area?: string;
  city?: string;
  state?: string;
};

/** Open Location Code, e.g. "Q3F2+HX" or "7FG6Q3F2+HX". */
const PLUS_CODE = /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}(?=[\s,]|$)/i;

export function isPlusCode(address: string | null | undefined): boolean {
  return PLUS_CODE.test((address ?? "").trim());
}

const pick = (components: AddressComponent[], ...types: string[]): string | undefined => {
  for (const t of types) {
    const hit = components.find((c) => c.types.includes(t));
    if (hit?.longText) return hit.longText;
  }
  return undefined;
};

const unique = (parts: (string | undefined)[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const v = p?.trim();
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
};

export function composeAddress(input: {
  formattedAddress: string;
  displayName?: string | null;
  components?: AddressComponent[] | null;
}): AddressParts {
  const components = input.components ?? [];
  const street = [pick(components, "street_number"), pick(components, "route")].filter(Boolean).join(" ") || undefined;
  const area = pick(components, "neighborhood", "sublocality_level_1", "sublocality", "administrative_area_level_3");
  const city = pick(components, "locality", "administrative_area_level_2");
  const state = pick(components, "administrative_area_level_1");

  const formatted = input.formattedAddress.trim();
  const firstSegment = formatted.split(",")[0]?.trim().toLowerCase();
  const name = input.displayName?.trim();
  const usefulName =
    name && !isPlusCode(name) && name.toLowerCase() !== firstSegment ? name : undefined;

  let formattedAddress = formatted;
  if (isPlusCode(formatted)) {
    const rebuilt = unique([usefulName ?? name, street, area, city, state]);
    if (rebuilt.length >= 2) formattedAddress = rebuilt.join(", ");
  }

  return { formattedAddress, name: usefulName, area, city, state };
}
