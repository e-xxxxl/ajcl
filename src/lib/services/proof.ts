import { Types } from "mongoose";
import { ApiError } from "../api";
import { env } from "../env";
import { HandoverProof } from "../../models/HandoverProof";
import { ProofPhoto } from "../../models/ProofPhoto";
import { haversineKm, pointOf, type StopLocation } from "./route-plan";
import {
  cloudStorageEnabled,
  uploadProofPhoto,
  downloadProofPhoto,
  destroyProofPhotos,
  type UploadedPhoto,
} from "../storage/cloudinary";
import type { ProofDTO } from "../../types";

export const MAX_PROOF_PHOTOS = 2;
const MIN_PHOTO_BYTES = 3_000; // anything smaller is not a real photo
const MAX_PHOTO_BYTES = 700_000; // the app resizes to ~100-200 KB; this is a safety cap
/** A GPS fix older than this is refused, so a rider can't reuse an earlier position. */
const MAX_FIX_AGE_MS = 3 * 60 * 1000;

export type PhotoContentType = "image/jpeg" | "image/png" | "image/webp";

export type LocationInput = {
  lat: number;
  lng: number;
  accuracyM?: number;
  /** How old the fix is, in ms, measured on the device (so a wrong phone clock does not matter). */
  ageMs: number;
};

/** Decode and validate a `data:image/...;base64,` photo. Checks the real file signature. */
export function parsePhoto(dataUrl: string): { contentType: PhotoContentType; buffer: Buffer } {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl.trim());
  if (!m) throw new ApiError("That file isn't a supported photo. Take a new picture.", 422);
  const buffer = Buffer.from(m[2], "base64");

  if (buffer.length < MIN_PHOTO_BYTES) throw new ApiError("That photo looks empty. Take a new picture.", 422);
  if (buffer.length > MAX_PHOTO_BYTES) {
    throw new ApiError("That photo is too large. Take a new picture and try again.", 413);
  }

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng = buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isWebp = buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  const ok =
    (m[1] === "image/jpeg" && isJpeg) || (m[1] === "image/png" && isPng) || (m[1] === "image/webp" && isWebp);
  if (!ok) throw new ApiError("That file isn't a valid photo. Take a new picture.", 422);

  return { contentType: m[1] as PhotoContentType, buffer };
}

/** Validate the rider's GPS fix and normalise its timestamp. */
export function checkLocation(input: LocationInput): { lat: number; lng: number; accuracyM?: number; capturedAt: Date } {
  if (!Number.isFinite(input.ageMs) || input.ageMs > MAX_FIX_AGE_MS) {
    throw new ApiError("Your location is out of date. Capture it again.", 422);
  }
  const capturedAt = new Date(Date.now() - Math.max(0, input.ageMs));
  return {
    lat: input.lat,
    lng: input.lng,
    accuracyM: typeof input.accuracyM === "number" ? Math.round(input.accuracyM) : undefined,
    capturedAt,
  };
}

/**
 * How far the rider was from the booked address, and whether that's suspicious.
 * Flagged only when the gap is larger than the radius PLUS the fix's own accuracy,
 * so a weak GPS signal doesn't raise false alarms.
 */
export function assessLocation(
  fix: { lat: number; lng: number; accuracyM?: number },
  target: StopLocation | null | undefined,
): { distanceFromTargetM?: number; flagged: boolean } {
  const t = pointOf(target ?? null);
  if (!t) return { flagged: false };
  const distanceM = Math.round(haversineKm({ lat: fix.lat, lng: fix.lng }, t) * 1000);
  return {
    distanceFromTargetM: distanceM,
    flagged: distanceM > env.proofRadiusM + (fix.accuracyM ?? 0),
  };
}

/** Delete proof photos (and their Cloudinary copies) matching a filter. */
export async function deleteProofPhotos(filter: Record<string, unknown>): Promise<void> {
  const docs = await ProofPhoto.find(filter).select("storage publicId").lean();
  await destroyProofPhotos(
    docs.filter((d) => d.storage === "cloudinary" && d.publicId).map((d) => d.publicId as string),
  );
  await ProofPhoto.deleteMany(filter);
}

/**
 * Store the photos and the proof record. Photos go to the AJCL folder on Cloudinary when
 * it is configured; if Cloudinary is off or the upload fails they are kept in MongoDB
 * instead, so a rider is never blocked from confirming a handover.
 */
export async function saveProof(params: {
  bookingId: unknown;
  bookingReference: string;
  stage: "pickup" | "delivery";
  riderId: string;
  riderName: string;
  photos: { contentType: PhotoContentType; buffer: Buffer }[];
  fix: { lat: number; lng: number; accuracyM?: number; capturedAt: Date };
  assessment: { distanceFromTargetM?: number; flagged: boolean };
}) {
  const bookingId = String(params.bookingId);
  let saved: { _id: unknown }[] | null = null;

  if (cloudStorageEnabled()) {
    const uploaded: UploadedPhoto[] = [];
    try {
      for (const p of params.photos) {
        uploaded.push(
          await uploadProofPhoto({
            buffer: p.buffer,
            contentType: p.contentType,
            bookingReference: params.bookingReference,
            stage: params.stage,
          }),
        );
      }
      saved = await ProofPhoto.insertMany(
        uploaded.map((u, i) => ({
          booking: bookingId,
          contentType: params.photos[i].contentType,
          size: u.bytes || params.photos[i].buffer.length,
          storage: "cloudinary" as const,
          publicId: u.publicId,
          version: u.version,
          format: u.format,
        })),
      );
    } catch (err) {
      console.error(
        "[proof] Cloudinary upload failed, keeping the photos in MongoDB instead:",
        err instanceof Error ? err.message : err,
      );
      await destroyProofPhotos(uploaded.map((u) => u.publicId));
      saved = null;
    }
  }

  if (!saved) {
    saved = await ProofPhoto.insertMany(
      params.photos.map((p) => ({
        booking: bookingId,
        contentType: p.contentType,
        size: p.buffer.length,
        storage: "mongo" as const,
        data: p.buffer,
      })),
    );
  }

  try {
    return await HandoverProof.create({
      booking: bookingId,
      bookingReference: params.bookingReference,
      stage: params.stage,
      rider: params.riderId,
      riderName: params.riderName,
      location: { ...params.fix, ...params.assessment },
      photos: saved.map((x) => x._id as never),
    });
  } catch (err) {
    await deleteProofPhotos({ _id: { $in: saved.map((x) => String(x._id)) } });
    throw err;
  }
}

/** Undo `saveProof` (used when the booking can't be moved on after the evidence was stored). */
export async function deleteProof(proofId: unknown) {
  const proof = await HandoverProof.findById(String(proofId)).lean();
  if (!proof) return;
  await deleteProofPhotos({ _id: { $in: proof.photos.map(String) } });
  await HandoverProof.deleteOne({ _id: proof._id });
}

type ProofLean = {
  _id: unknown;
  stage: string;
  riderName?: string | null;
  createdAt?: Date;
  photos: unknown[];
  location?: {
    lat: number;
    lng: number;
    accuracyM?: number | null;
    capturedAt: Date;
    distanceFromTargetM?: number | null;
    flagged?: boolean | null;
  } | null;
};

/** Proofs for a booking. `withLocation` is for admins only; the customer sees photos and times. */
export async function listProofs(bookingId: unknown, withLocation: boolean): Promise<ProofDTO[]> {
  const proofs = (await HandoverProof.find({ booking: String(bookingId) })
    .sort({ createdAt: 1 })
    .lean()) as unknown as ProofLean[];
  return proofs.map((p) => toProofDTO(p, withLocation));
}

export function toProofDTO(p: ProofLean, withLocation: boolean): ProofDTO {
  return {
    id: String(p._id),
    stage: p.stage as ProofDTO["stage"],
    riderName: p.riderName ?? undefined,
    takenAt: new Date(p.location?.capturedAt ?? p.createdAt ?? Date.now()).toISOString(),
    photoIds: p.photos.map(String),
    location:
      withLocation && p.location
        ? {
            lat: p.location.lat,
            lng: p.location.lng,
            accuracyM: p.location.accuracyM ?? undefined,
            distanceFromTargetM: p.location.distanceFromTargetM ?? undefined,
            flagged: Boolean(p.location.flagged),
          }
        : undefined,
  };
}

/** Photo bytes for a booking. Returns null if the id doesn't belong to that booking. */
export async function getPhoto(bookingId: unknown, photoId: string) {
  if (!Types.ObjectId.isValid(photoId)) return null;
  const photo = await ProofPhoto.findOne({ _id: photoId, booking: String(bookingId) }).select("+data");
  if (!photo) return null;

  if (photo.storage === "cloudinary" && photo.publicId) {
    try {
      const data = await downloadProofPhoto({
        publicId: photo.publicId,
        version: photo.version ?? undefined,
        format: photo.format ?? undefined,
      });
      return { contentType: photo.contentType, data };
    } catch (err) {
      console.error("[proof] could not read photo from Cloudinary:", err instanceof Error ? err.message : err);
      throw new ApiError("The photo is temporarily unavailable. Please try again.", 502);
    }
  }
  return { contentType: photo.contentType, data: photo.data as Buffer };
}
