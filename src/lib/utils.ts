/** Generate a booking reference like "AJC-8F3K2Q". */
export function generateBookingReference(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `AJC-${code}`;
}

/** Slugify a string for use in ids. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Small helper to pause execution. */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
