import crypto from "node:crypto";
import { v2 as cloudinaryLib } from "cloudinary";
import { env, isCloudinaryConfigured } from "../env";

/**
 * Cloudinary storage for proof photos.
 *
 * Photos are uploaded as `authenticated` assets: they have no public URL, so nobody can
 * open one without a signed link. We never hand that link to a browser. Instead the API
 * checks who is asking (admin / the booking's own customer) and streams the bytes itself.
 * Everything lives under the `AJCL` folder.
 */

export type UploadedPhoto = { publicId: string; version: number; format: string; bytes: number };

/** The few Cloudinary calls we use, so tests can swap in a fake. */
export interface CloudClient {
  upload(dataUri: string, opts: { publicId: string; assetFolder: string; tags: string[] }): Promise<UploadedPhoto>;
  destroy(publicIds: string[]): Promise<void>;
  download(photo: { publicId: string; version?: number; format?: string }): Promise<Buffer>;
  createFolder(path: string): Promise<void>;
}

let configured = false;
function configure() {
  if (configured) return;
  cloudinaryLib.config({
    cloud_name: env.cloudinary.cloudName,
    api_key: env.cloudinary.apiKey,
    api_secret: env.cloudinary.apiSecret,
    secure: true,
  });
  configured = true;
}

const realClient: CloudClient = {
  async upload(dataUri, opts) {
    configure();
    const res = await cloudinaryLib.uploader.upload(dataUri, {
      public_id: opts.publicId,
      // Works in both Cloudinary folder modes: the path in public_id (fixed mode) and
      // asset_folder (dynamic mode) both resolve to the AJCL folder.
      asset_folder: opts.assetFolder,
      type: "authenticated",
      resource_type: "image",
      overwrite: false,
      tags: opts.tags,
    });
    return { publicId: res.public_id, version: res.version, format: res.format, bytes: res.bytes };
  },
  async destroy(publicIds) {
    configure();
    if (publicIds.length === 0) return;
    await cloudinaryLib.api.delete_resources(publicIds, { type: "authenticated", resource_type: "image" });
  },
  async download(photo) {
    configure();
    const url = cloudinaryLib.url(photo.publicId, {
      type: "authenticated",
      resource_type: "image",
      sign_url: true,
      secure: true,
      version: photo.version,
      format: photo.format,
    });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Cloudinary returned ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
  async createFolder(path) {
    configure();
    await cloudinaryLib.api.create_folder(path);
  },
};

let client: CloudClient = realClient;
/** Test hook: replace the Cloudinary client. */
export function setCloudClientForTests(fake: CloudClient | null) {
  client = fake ?? realClient;
}

/** True when proof photos should go to Cloudinary. (Always true under a test client.) */
export function cloudStorageEnabled(): boolean {
  return client !== realClient || isCloudinaryConfigured;
}

const FORMAT_FOR: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export async function uploadProofPhoto(params: {
  buffer: Buffer;
  contentType: string;
  bookingReference: string;
  stage: "pickup" | "delivery";
}): Promise<UploadedPhoto> {
  const folder = env.cloudinary.folder;
  const id = crypto.randomBytes(8).toString("hex");
  const publicId = `${folder}/proofs/${params.bookingReference}/${params.stage}-${id}`;
  const dataUri = `data:${params.contentType};base64,${params.buffer.toString("base64")}`;
  const out = await client.upload(dataUri, {
    publicId,
    assetFolder: `${folder}/proofs/${params.bookingReference}`,
    tags: ["proof", params.stage, params.bookingReference],
  });
  return { ...out, format: out.format || FORMAT_FOR[params.contentType] || "jpg" };
}

export async function downloadProofPhoto(photo: { publicId: string; version?: number; format?: string }): Promise<Buffer> {
  return client.download(photo);
}

/** Best effort: a failed delete is logged, never thrown (the DB record is the source of truth). */
export async function destroyProofPhotos(publicIds: string[]): Promise<void> {
  if (publicIds.length === 0) return;
  try {
    await client.destroy(publicIds);
  } catch (err) {
    console.error("[cloudinary] could not delete", publicIds.length, "photo(s):", err instanceof Error ? err.message : err);
  }
}

/** Create the AJCL folder up front (it is also created automatically by the first upload). */
export async function ensureCloudinaryFolder(): Promise<void> {
  if (!cloudStorageEnabled()) return;
  try {
    await client.createFolder(env.cloudinary.folder);
    console.info(`[cloudinary] folder "${env.cloudinary.folder}" is ready`);
  } catch (err) {
    console.warn("[cloudinary] folder check skipped:", err instanceof Error ? err.message : err);
  }
}
