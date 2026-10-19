import { Router } from "express";
import { z } from "zod";
import { ok, asyncHandler, parse, ApiError } from "../lib/api";
import { requireSuperAdmin } from "../lib/auth/middleware";
import { connectToDatabase } from "../lib/db";
import { SiteAsset, PriceList } from "../models";
import {
  SLIDE_KEYS,
  getSlides,
  getAirCargo,
  getExpress,
  getSeaFlier,
  getLatestPriceList,
  getSiteContentDoc,
  decodeDataUrl,
  appendDisclaimerPage,
  assetUrl,
  DEFAULT_SLIDES,
  DEFAULT_AIR_CARGO,
  DEFAULT_EXPRESS,
} from "../lib/services/site-content";
import { getShippingSettings } from "../lib/services/shipping-settings";
import { publicShippingConfig } from "./shipments";

/** Public site content for the homepage slider, Air Cargo, Sea flier and AJCL Express pages. */
export const siteRouter = Router();

siteRouter.get(
  "/home",
  asyncHandler(async (_req, res) => {
    const [slides, seaFlier, priceList, config] = await Promise.all([
      getSlides(),
      getSeaFlier(),
      getLatestPriceList(),
      publicShippingConfig(),
    ]);
    return ok(res, { slides: slides.filter((s) => s.active), seaFlier, priceList, disclaimerParagraphs: config.disclaimerParagraphs });
  }),
);

siteRouter.get("/air-cargo", asyncHandler(async (_req, res) => ok(res, { page: await getAirCargo() })));

siteRouter.get(
  "/express",
  asyncHandler(async (_req, res) => ok(res, { page: await getExpress() })),
);

/** GET /api/site/assets/:id: stream a slide image, the sea flier or a price list PDF. */
siteRouter.get(
  "/assets/:id",
  asyncHandler(async (req, res) => {
    await connectToDatabase();
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw new ApiError("File not found.", 404);
    const asset = await SiteAsset.findById(req.params.id).select("+data contentType filename purpose");
    if (!asset || !asset.data) throw new ApiError("File not found.", 404);

    // Only the newest price list is public; older ones stay on record for the admin.
    if (asset.purpose === "price_list") {
      const latest = await getLatestPriceList();
      if (!latest || !latest.downloadUrl.includes(String(asset._id))) throw new ApiError("File not found.", 404);
    }

    res.setHeader("Content-Type", asset.contentType);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const name = (asset.filename || "download").replace(/[^\w.\- ]+/g, "_");
    res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${name}"`);
    res.send(asset.data);
  }),
);

/* ── Super Admin editing ───────────────────────────────────────────────── */

export const siteAdminRouter = Router();

siteAdminRouter.get(
  "/content",
  asyncHandler(async (req, res) => {
    requireSuperAdmin(req);
    const [slides, air, express, flier, latest, history, settings] = await Promise.all([
      getSlides(),
      getAirCargo(),
      getExpress(),
      getSeaFlier(),
      getLatestPriceList(),
      PriceList.find({}).sort({ effectiveMonth: -1, createdAt: -1 }).limit(24).lean(),
      getShippingSettings(),
    ]);
    return ok(res, {
      slides,
      defaults: { slides: DEFAULT_SLIDES, airCargo: DEFAULT_AIR_CARGO, express: DEFAULT_EXPRESS },
      airCargo: air,
      express: { title: express.title, intro: express.intro, paragraphs: express.paragraphs },
      seaFlier: flier,
      priceList: latest,
      priceListHistory: history.map((p) => ({
        id: String(p._id),
        monthLabel: p.monthLabel,
        effectiveMonth: p.effectiveMonth,
        uploadedByName: p.uploadedByName ?? null,
        uploadedAt: new Date((p as { createdAt?: Date }).createdAt ?? Date.now()).toISOString(),
        isCurrent: latest?.id === String(p._id),
      })),
      disclaimerParagraphs: settings.disclaimerParagraphs,
    });
  }),
);

const contentSchema = z.object({
  slides: z
    .array(
      z.object({
        key: z.enum(SLIDE_KEYS as [string, ...string[]]),
        title: z.string().trim().max(120).optional(),
        subtitle: z.string().trim().max(240).optional(),
        ctaLabel: z.string().trim().max(40).optional(),
        active: z.boolean().optional(),
      }),
    )
    .optional(),
  airCargo: z
    .object({
      title: z.string().trim().max(120).optional(),
      intro: z.string().trim().max(1200).optional(),
      sections: z.array(z.object({ heading: z.string().trim().max(120), body: z.string().trim().max(2000) })).max(12).optional(),
    })
    .optional(),
  express: z
    .object({
      title: z.string().trim().max(120).optional(),
      intro: z.string().trim().max(1200).optional(),
      paragraphs: z.array(z.string().trim().min(1).max(1500)).max(10).optional(),
    })
    .optional(),
});

siteAdminRouter.put(
  "/content",
  asyncHandler(async (req, res) => {
    requireSuperAdmin(req);
    const input = parse(contentSchema, req.body);
    const doc = await getSiteContentDoc();

    if (input.slides) {
      for (const s of input.slides) {
        const existing = doc.slides.find((x) => x.key === s.key);
        const next = {
          key: s.key,
          title: s.title || undefined,
          subtitle: s.subtitle || undefined,
          ctaLabel: s.ctaLabel || undefined,
          active: s.active !== false,
          imageAsset: existing?.imageAsset,
        };
        if (existing) Object.assign(existing, next);
        else doc.slides.push(next as never);
      }
    }
    if (input.airCargo) {
      doc.set("airCargo", {
        title: input.airCargo.title || undefined,
        intro: input.airCargo.intro || undefined,
        sections: input.airCargo.sections?.length ? input.airCargo.sections : undefined,
      });
    }
    if (input.express) {
      doc.set("express", {
        title: input.express.title || undefined,
        intro: input.express.intro || undefined,
        paragraphs: input.express.paragraphs?.length ? input.express.paragraphs : undefined,
      });
    }
    await doc.save();
    return ok(res, { saved: true });
  }),
);

const assetSchema = z.object({
  purpose: z.enum(["slide", "flier"]),
  slideKey: z.enum(SLIDE_KEYS as [string, ...string[]]).optional(),
  filename: z.string().trim().max(160).optional(),
  dataUrl: z.string().min(50),
});

/** POST /api/admin/site/assets: upload a slide image or the Sea Cargo flier (image or PDF). */
siteAdminRouter.post(
  "/assets",
  asyncHandler(async (req, res) => {
    const session = requireSuperAdmin(req);
    const input = parse(assetSchema, req.body);
    await connectToDatabase();
    if (input.purpose === "slide" && !input.slideKey) throw new ApiError("Choose which slide this image is for.", 422);

    const allowed = input.purpose === "slide" ? ["image/jpeg", "image/png", "image/webp"] : ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    const { contentType, buffer } = decodeDataUrl(input.dataUrl, allowed, input.purpose === "slide" ? 2_500_000 : 8_000_000);

    const asset = await SiteAsset.create({
      purpose: input.purpose,
      filename: input.filename,
      contentType,
      size: buffer.length,
      data: buffer,
      storage: "mongo",
      uploadedBy: session.sub,
    });

    const doc = await getSiteContentDoc();
    let previous: unknown;
    if (input.purpose === "flier") {
      previous = doc.seaFlier;
      doc.seaFlier = asset._id as never;
    } else {
      let slide = doc.slides.find((s) => s.key === input.slideKey);
      if (!slide) {
        doc.slides.push({ key: input.slideKey, active: true } as never);
        slide = doc.slides[doc.slides.length - 1];
      }
      previous = slide.imageAsset;
      slide.imageAsset = asset._id as never;
    }
    await doc.save();
    if (previous) await SiteAsset.deleteOne({ _id: previous }).catch(() => undefined);
    return ok(res, { url: assetUrl(asset._id) }, 201);
  }),
);

/** DELETE /api/admin/site/assets/:purpose/:key: remove a slide image (back to the default look) or the flier. */
siteAdminRouter.delete(
  "/assets/:purpose/:key?",
  asyncHandler(async (req, res) => {
    requireSuperAdmin(req);
    const doc = await getSiteContentDoc();
    let previous: unknown;
    if (req.params.purpose === "flier") {
      previous = doc.seaFlier;
      doc.seaFlier = undefined;
    } else if (req.params.purpose === "slide") {
      const slide = doc.slides.find((s) => s.key === req.params.key);
      previous = slide?.imageAsset;
      if (slide) slide.imageAsset = undefined;
    } else {
      throw new ApiError("Unknown file.", 404);
    }
    await doc.save();
    if (previous) await SiteAsset.deleteOne({ _id: previous }).catch(() => undefined);
    return ok(res, { removed: true });
  }),
);

const priceListSchema = z.object({
  effectiveMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose the month this list applies to"),
  filename: z.string().trim().max(160).optional(),
  dataUrl: z.string().min(50),
});

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** POST /api/admin/site/price-lists: upload this month's AJCL Express PDF. The notice is added as the last page. */
siteAdminRouter.post(
  "/price-lists",
  asyncHandler(async (req, res) => {
    const session = requireSuperAdmin(req);
    const input = parse(priceListSchema, req.body);
    await connectToDatabase();

    const { buffer } = decodeDataUrl(input.dataUrl, ["application/pdf"], 8_000_000);
    const settings = await getShippingSettings();
    const finalPdf = await appendDisclaimerPage(buffer, settings.disclaimerParagraphs);

    const [y, m] = input.effectiveMonth.split("-").map(Number);
    const monthLabel = `${MONTHS[m - 1]} ${y}`;
    const filename = input.filename?.toLowerCase().endsWith(".pdf") ? input.filename : `AJCL-Express-${MONTHS[m - 1]}-${y}.pdf`;

    const asset = await SiteAsset.create({
      purpose: "price_list",
      filename,
      contentType: "application/pdf",
      size: finalPdf.length,
      data: finalPdf,
      storage: "mongo",
      uploadedBy: session.sub,
    });
    const list = await PriceList.create({
      monthLabel,
      effectiveMonth: input.effectiveMonth,
      asset: asset._id,
      originalFilename: filename,
      uploadedBy: session.sub,
      uploadedByName: session.name,
    });
    return ok(res, { priceList: { id: String(list._id), monthLabel, effectiveMonth: input.effectiveMonth } }, 201);
  }),
);
