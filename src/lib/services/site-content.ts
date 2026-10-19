import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { SiteContent, SiteAsset, PriceList } from "../../models";
import { ApiError } from "../api";
import { connectToDatabase } from "../db";
import { getShippingSettings } from "./shipping-settings";

/**
 * Editable public-site content: the homepage slider, the Air Cargo page, the AJCL Express page,
 * the Sea Cargo flier and the monthly Express price list. The Super Admin only stores what they
 * change; everything else falls back to the defaults below, so the site always has content.
 */

export type SlideKey = "local" | "international" | "air" | "sea" | "express";
export const SLIDE_KEYS: SlideKey[] = ["local", "international", "air", "sea", "express"];

type SlideDefault = { key: SlideKey; title: string; subtitle: string; ctaLabel: string; href: string };

export const DEFAULT_SLIDES: SlideDefault[] = [
  {
    key: "local",
    title: "Same-day delivery, door to door.",
    subtitle: "Book a rider in minutes, pay securely and follow your package live from pickup to drop-off.",
    ctaLabel: "Send a package",
    href: "/send",
  },
  {
    key: "international",
    title: "Ship worldwide with confidence.",
    subtitle: "Documents and parcels to destinations worldwide. Get a live quote before you commit to anything.",
    ctaLabel: "Get a quote",
    href: "/quote",
  },
  {
    key: "air",
    title: "Air cargo, when time matters.",
    subtitle: "Move heavier consignments by air with clear handling and dependable timelines.",
    ctaLabel: "Learn more",
    href: "/air-cargo",
  },
  {
    key: "sea",
    title: "Sea freight for the big loads.",
    subtitle: "The economical way to move large volumes overseas. See our latest flier.",
    ctaLabel: "View flier",
    href: "#sea-flier",
  },
  {
    key: "express",
    title: "AJCL Express",
    subtitle: "Prices change every month. See this month's price list.",
    ctaLabel: "See current prices",
    href: "/express",
  },
];

export const DEFAULT_AIR_CARGO = {
  title: "Air cargo",
  intro:
    "When your freight cannot wait, air cargo gets it there in days. AJ Courier & Logistics handles the booking, documentation guidance and hand-off so you can focus on your business.",
  sections: [
    {
      heading: "What we move",
      body: "Commercial goods, samples, spare parts, fashion and retail stock, and time-sensitive documents. Tell us what you are shipping and we will advise on the best option.",
    },
    {
      heading: "How it works",
      body: "Contact our team with your cargo details. We confirm the route, weight and price, collect or receive your goods at our office, and keep you updated until delivery.",
    },
    {
      heading: "Pricing",
      body: "Air cargo is priced by weight and destination. Contact us for a quote tailored to your consignment.",
    },
  ],
};

export const DEFAULT_EXPRESS = {
  title: "AJCL Express",
  intro:
    "AJCL Express is our scheduled consolidated service, with prices that are reviewed every month. The current price list is below.",
  paragraphs: [
    "Our Express rates are set monthly so you always pay a fair price for the season. Each price list is clearly marked with the month it applies to.",
    "Download the latest PDF to see rates by destination and weight. If you need help choosing the right service, our team is ready to assist.",
  ],
};

export async function getSiteContentDoc() {
  await connectToDatabase();
  // One atomic upsert: several requests asking at once must not each try to create the record.
  const doc = await SiteContent.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  if (!doc) throw new Error("Could not load the site content");
  return doc;
}

export const assetUrl = (id: unknown) => `/api/site/assets/${String(id)}`;

export async function getSlides() {
  const doc = await getSiteContentDoc();
  return SLIDE_KEYS.map((key) => {
    const d = DEFAULT_SLIDES.find((s) => s.key === key)!;
    const o = doc.slides.find((s) => s.key === key);
    return {
      key,
      title: o?.title || d.title,
      subtitle: o?.subtitle || d.subtitle,
      ctaLabel: o?.ctaLabel || d.ctaLabel,
      href: d.href,
      imageUrl: o?.imageAsset ? assetUrl(o.imageAsset) : null,
      active: o?.active !== false,
    };
  });
}

export async function getAirCargo() {
  const doc = await getSiteContentDoc();
  return {
    title: doc.airCargo?.title || DEFAULT_AIR_CARGO.title,
    intro: doc.airCargo?.intro || DEFAULT_AIR_CARGO.intro,
    sections: doc.airCargo?.sections?.length
      ? doc.airCargo.sections.map((s) => ({ heading: s.heading ?? "", body: s.body ?? "" }))
      : DEFAULT_AIR_CARGO.sections,
  };
}

export async function getLatestPriceList() {
  await connectToDatabase();
  const latest = await PriceList.findOne({}).sort({ effectiveMonth: -1, createdAt: -1 }).lean();
  if (!latest) return null;
  return {
    id: String(latest._id),
    monthLabel: latest.monthLabel,
    effectiveMonth: latest.effectiveMonth,
    uploadedAt: new Date((latest as { createdAt?: Date }).createdAt ?? Date.now()).toISOString(),
    downloadUrl: `${assetUrl(latest.asset)}?download=1`,
    filename: latest.originalFilename ?? `AJCL-Express-${latest.effectiveMonth}.pdf`,
  };
}

export async function getExpress() {
  const [doc, settings, priceList] = await Promise.all([getSiteContentDoc(), getShippingSettings(), getLatestPriceList()]);
  return {
    title: doc.express?.title || DEFAULT_EXPRESS.title,
    intro: doc.express?.intro || DEFAULT_EXPRESS.intro,
    paragraphs: doc.express?.paragraphs?.length ? doc.express.paragraphs : DEFAULT_EXPRESS.paragraphs,
    priceList,
    disclaimerParagraphs: settings.disclaimerParagraphs,
  };
}

export async function getSeaFlier() {
  const doc = await getSiteContentDoc();
  if (!doc.seaFlier) return null;
  const asset = await SiteAsset.findById(doc.seaFlier).select("contentType filename").lean();
  if (!asset) return null;
  return { url: assetUrl(doc.seaFlier), downloadUrl: `${assetUrl(doc.seaFlier)}?download=1`, contentType: asset.contentType, filename: asset.filename ?? "sea-cargo-flier" };
}

/* ── Uploads ───────────────────────────────────────────────────────────── */

export function decodeDataUrl(dataUrl: string, allowed: string[], maxBytes: number): { contentType: string; buffer: Buffer } {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+=*)$/i.exec(dataUrl.trim());
  if (!m) throw new ApiError("That file could not be read.", 422);
  const contentType = m[1].toLowerCase();
  if (!allowed.includes(contentType)) throw new ApiError("That file type is not supported.", 422);
  const buffer = Buffer.from(m[2], "base64");
  if (buffer.length === 0) throw new ApiError("That file is empty.", 422);
  if (buffer.length > maxBytes) throw new ApiError(`That file is too large (max ${Math.round(maxBytes / 1_000_000)} MB).`, 413);

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng = buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isWebp = buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  const isPdf = buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  const valid =
    (contentType === "image/jpeg" && isJpeg) ||
    (contentType === "image/png" && isPng) ||
    (contentType === "image/webp" && isWebp) ||
    (contentType === "application/pdf" && isPdf);
  if (!valid) throw new ApiError("That file does not look like a valid " + contentType.split("/")[1].toUpperCase() + ".", 422);
  return { contentType, buffer };
}

function wrap(raw: string, font: PDFFont, size: number, maxWidth: number): string[] {
  // The built-in PDF font only covers Latin-1; drop anything else rather than failing the upload.
  const text = raw.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Append the standard notice as the last page of a price list PDF. */
export async function appendDisclaimerPage(pdf: Buffer, paragraphs: string[]): Promise<Buffer> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, { ignoreEncryption: false });
  } catch {
    throw new ApiError("That PDF could not be opened. Check the file and try again.", 422);
  }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]);
  const margin = 56;
  const width = page.getWidth() - margin * 2;
  let y = page.getHeight() - 90;

  page.drawText("Important notice", { x: margin, y, size: 22, font: bold, color: rgb(0.1, 0.1, 0.1) });
  y -= 14;
  page.drawLine({ start: { x: margin, y }, end: { x: margin + width, y }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
  y -= 34;

  paragraphs.forEach((p, i) => {
    const lines = wrap(`${i + 1}. ${p}`, font, 12, width);
    for (const l of lines) {
      page.drawText(l, { x: margin, y, size: 12, font, color: rgb(0.15, 0.15, 0.15) });
      y -= 18;
    }
    y -= 10;
  });

  return Buffer.from(await doc.save());
}
