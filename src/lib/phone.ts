/**
 * Phone numbers for the carrier. Terminal rejects anything that is not in international format
 * ("+" and the country code), so this turns what people type into that form, or says it cannot.
 *
 * Nigerian numbers may be typed the usual local way (0803 123 4567); for every other country the
 * number must already start with "+" and the country code. The same file is in the frontend (src/lib/phone.ts).
 */
export function toInternationalPhone(raw: string, country = "NG", opts: { strict?: boolean } = {}): string | null {
  let v = String(raw ?? "").trim().replace(/[\s().-]/g, "");
  if (!v) return null;
  if (v.startsWith("00")) v = `+${v.slice(2)}`;

  if (v.startsWith("+")) {
    // A trunk zero after the Nigerian code (+234 0803...) is a common slip.
    if (/^\+2340\d{10}$/.test(v)) v = `+234${v.slice(5)}`;
    if (v.startsWith("+234")) return /^\+234\d{10}$/.test(v) ? v : null;
    return /^\+[1-9]\d{7,14}$/.test(v) ? v : null;
  }

  if (!/^\d+$/.test(v)) return null;
  // Strict: the number must already carry its country code. Nothing is guessed from the address.
  if (opts.strict) return null;
  if (country.toUpperCase() === "NG") {
    if (/^234\d{10}$/.test(v)) return `+${v}`;
    if (/^0\d{10}$/.test(v)) return `+234${v.slice(1)}`;
    if (/^[789]\d{9}$/.test(v)) return `+234${v}`;
  }
  return null;
}

/** What to tell the person when a number cannot be used. */
export function phoneProblem(_country = "NG"): string {
  return "Enter the phone number with its country code, like +234 803 123 4567 (UK: +44 7700 900123)";
}
