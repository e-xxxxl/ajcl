/**
 * Render every transactional email template to backend/email-previews/*.html
 * so you can eyeball them in a browser without sending anything.
 *
 *   npm run build && node scripts/preview-emails.mjs
 *   # then open backend/email-previews/index.html
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.FRONTEND_URL ||= "http://localhost:5173";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "email-previews");
mkdirSync(out, { recursive: true });

const { emailForEvent, passwordResetEmail, welcomeEmail } = await import(
  pathToFileURL(resolve(here, "..", "dist", "lib", "email", "templates.js")).href
);

const samples = [
  ["welcome", welcomeEmail({ name: "Ada" })],
  ["password-reset", passwordResetEmail({ name: "Ada", resetUrl: "http://localhost:5173/reset-password?token=demo" })],
  ...[
    "booking_created",
    "payment_succeeded",
    "payment_failed",
    "booking_confirmed",
    "driver_assigned",
    "in_transit",
    "delivered",
    "booking_cancelled",
    "admin_new_booking",
  ].map((type) => [
    type,
    emailForEvent({ type, bookingReference: "AJC-8F3K2Q", recipientName: "Ada", title: type, body: type }),
  ]),
];

for (const [name, mail] of samples) {
  writeFileSync(resolve(out, `${name}.html`), mail.html);
}
writeFileSync(
  resolve(out, "index.html"),
  `<h1>AJ Courier email previews</h1><ul>${samples
    .map(([n, m]) => `<li><a href="${n}.html">${n}</a> — <code>${m.subject}</code></li>`)
    .join("")}</ul>`,
);
console.log(`Wrote ${samples.length} previews to ${out}`);
