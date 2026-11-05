import { connectToDatabase } from "../db";
import { RideSettings } from "../../models/RideSettings";
import type { LongDistanceFee } from "../pricing/engine";

export type LongDistanceSettings = { enabled: boolean; thresholdKm: number; flatNgn: number; perKmNgn: number; updatedByName?: string; updatedAt?: string };

export async function getLongDistanceSettings(): Promise<LongDistanceSettings> {
  await connectToDatabase();
  const doc = await RideSettings.findOne({ key: "rides" }).lean();
  const l = doc?.longDistance;
  return {
    enabled: Boolean(l?.enabled),
    thresholdKm: l?.thresholdKm ?? 0,
    flatNgn: l?.flatNgn ?? 0,
    perKmNgn: l?.perKmNgn ?? 0,
    updatedByName: doc?.updatedByName ?? undefined,
    updatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : undefined,
  };
}

/** The fee to apply to a new ride delivery, or null when it is switched off. */
export async function getLongDistanceFee(): Promise<LongDistanceFee | null> {
  const s = await getLongDistanceSettings();
  if (!s.enabled || !(s.thresholdKm > 0) || !(s.flatNgn > 0 || s.perKmNgn > 0)) return null;
  return { thresholdKm: s.thresholdKm, flatNgn: s.flatNgn, perKmNgn: s.perKmNgn };
}

export async function saveLongDistanceSettings(input: { enabled: boolean; thresholdKm: number; flatNgn: number; perKmNgn: number }, byName: string): Promise<LongDistanceSettings> {
  await connectToDatabase();
  await RideSettings.findOneAndUpdate(
    { key: "rides" },
    { $set: { longDistance: { enabled: input.enabled, thresholdKm: input.thresholdKm, flatNgn: input.flatNgn, perKmNgn: input.perKmNgn }, updatedByName: byName } },
    { upsert: true },
  );
  return getLongDistanceSettings();
}
