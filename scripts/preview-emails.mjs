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
import { createRequire } from "node:module";

process.env.FRONTEND_URL ||= "http://localhost:5173";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "email-previews");
mkdirSync(out, { recursive: true });

const load = (file) => import(pathToFileURL(resolve(here, "..", "dist", "lib", "email", file)).href);
const { emailForEvent, passwordResetEmail, welcomeEmail } = await load("templates.js");
const handover = await load("handover-templates.js");
const QRCode = createRequire(import.meta.url)("qrcode");

// Real emails reference the QR as an inline attachment (cid:). A browser can't
// resolve cid:, so swap in a data URI for the preview only.
const qrPng = async (code) => "data:image/png;base64," + (await QRCode.toBuffer(code, { type: "png", width: 360, margin: 2 })).toString("base64");
const withQr = async (mail, cid, code) => ({ ...mail, html: mail.html.replaceAll(`cid:${cid}`, await qrPng(code)) });

const rider = { name: "Tunde Adebayo", phone: "08012345678", plate: "LAG-123-XY" };
const route = {
  ref: "AJC-8F3K2Q",
  pickupAddress: "12 Allen Avenue, Ikeja, Lagos",
  destinationAddress: "Km 19 Lekki-Epe Expressway, Lagos",
  scheduledLabel: "Fri, 09 Oct 2026, 12:06 PM",
};

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
    "rider_job_assigned",
  ].map((type) => [
    type,
    emailForEvent({ type, bookingReference: "AJC-8F3K2Q", recipientName: "Ada", title: type, body: type }),
  ]),
  [
    "sender-confirmation",
    await withQr(
      handover.senderConfirmationEmail({ ...route, name: "Ada", vehicleName: "Bike", pickupCode: "511801", qrCid: "pickup-qr" }),
      "pickup-qr",
      "511801",
    ),
  ],
  [
    "receiver-confirmation",
    await withQr(
      handover.receiverConfirmationEmail({ ...route, name: "Testimony", senderName: "Ada Obi", deliveryCode: "407725", qrCid: "delivery-qr", trackingToken: "demo-token" }),
      "delivery-qr",
      "407725",
    ),
  ],
  ["sender-rider-assigned", handover.senderRiderAssignedEmail({ name: "Ada", ref: route.ref, rider, scheduledLabel: route.scheduledLabel })],
  ["receiver-rider-assigned", handover.receiverRiderAssignedEmail({ name: "Testimony", ref: route.ref, rider, scheduledLabel: route.scheduledLabel, trackingToken: "demo-token" })],
];

for (const [name, mail] of samples) {
  writeFileSync(resolve(out, `${name}.html`), mail.html);
}
writeFileSync(
  resolve(out, "index.html"),
  `<h1>AJ Courier email previews</h1><ul>${samples
    .map(([n, m]) => `<li><a href="${n}.html">${n}</a>: <code>${m.subject}</code></li>`)
    .join("")}</ul>`,
);
console.log(`Wrote ${samples.length} previews to ${out}`);
