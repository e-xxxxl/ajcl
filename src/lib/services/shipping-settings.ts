import { ShippingSettings } from "../../models";
import type { ShippingSettingsDoc } from "../../models";

/** The single shipping settings record. Created with the defaults on first read. */
export async function getShippingSettings() {
  // One atomic upsert: several requests asking at once must not each try to create the record.
  const doc = await ShippingSettings.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  if (!doc) throw new Error("Could not load the shipping settings");
  return doc;
}

export function exchangeRatesObject(settings: Pick<ShippingSettingsDoc, "exchangeRates">): Record<string, number> {
  const raw = settings.exchangeRates as unknown;
  const out: Record<string, number> = {};
  if (raw instanceof Map) {
    for (const [k, v] of raw) out[String(k)] = Number(v);
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = Number(v);
  }
  return out;
}

export function tiersOf(settings: Pick<ShippingSettingsDoc, "markupTiers">) {
  return settings.markupTiers.map((t) => ({ minKg: t.minKg, maxKg: t.maxKg, percent: t.percent }));
}
