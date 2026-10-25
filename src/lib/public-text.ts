/**
 * Customers are never told which service books their shipment. Anything that comes from the carrier service and
 * could carry its name (carrier names such as "Terminal Express", tracking links, tracking event wording) passes
 * through here before it reaches a customer. Staff see the original.
 */

/** "Terminal Express" becomes "Express Delivery", "Terminal Air Cargo" becomes "Air Cargo". */
export function publicCarrierName(name: string | null | undefined): string {
  const stripped = String(name ?? "")
    .replace(/terminal(\s+africa)?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!stripped) return "AJCL Shipping";
  return /^(express|premium|economy|standard|priority|saver)$/i.test(stripped) ? `${stripped} Delivery` : stripped;
}

/** Free text from the carrier service: swap the name for ours. */
export function publicText(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  return text.replace(/terminal(\s+africa)?/gi, "AJCL");
}

/** A tracking link on the carrier service's own site is not given to customers. */
export function publicTrackingUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  return /terminal\.africa|tship/i.test(url) ? undefined : url;
}

/** Notes on a shipment's history that are for staff only (how it was created or paid for offline). */
export function publicHistoryNote(note: string | null | undefined): string | undefined {
  if (!note) return undefined;
  if (/^(created by|booked without an online payment)/i.test(note)) return undefined;
  return publicText(note);
}
