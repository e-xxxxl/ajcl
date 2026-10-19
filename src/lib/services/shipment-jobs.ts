import { Shipment } from "../../models/Shipment";
import { connectToDatabase } from "../db";
import { env, isTerminalConfigured } from "../env";
import { bookWithTerminal, refreshWallet, syncTracking } from "./shipment-terminal";

/**
 * Background upkeep for shipments, run on a timer in the API process:
 *  - poll Terminal for tracking, as the fallback for webhooks that never arrived
 *  - finish any paid shipment whose booking was interrupted (e.g. the server restarted mid-call)
 *  - keep the carrier wallet reading fresh and raise the low-balance alert
 */
let running = false;

export async function runShipmentJobs(): Promise<void> {
  if (running || !isTerminalConfigured) return;
  running = true;
  try {
    await connectToDatabase();

    const stale = new Date(Date.now() - Math.max(60, env.terminal.pollIntervalSeconds) * 1000);
    const tracking = await Shipment.find({
      status: { $in: ["booked", "in_transit"] },
      "terminal.shipmentId": { $exists: true },
      $or: [{ "terminal.lastSyncedAt": { $exists: false } }, { "terminal.lastSyncedAt": { $lt: stale } }],
    }).limit(40);
    for (const s of tracking) await syncTracking(s).catch((err) => console.error("[shipment-jobs] sync failed", err));

    // Paid for more than 3 minutes ago and still not booked: the original attempt was interrupted.
    const stuck = await Shipment.find({
      status: "paid",
      shippingPaidAt: { $lt: new Date(Date.now() - 3 * 60 * 1000) },
      "terminal.trackingNumber": { $exists: false },
    }).limit(10);
    for (const s of stuck) {
      const option = s.quote.options.find((o) => o.rateId === s.quote.selectedRateId);
      if (option && !option.manual) await bookWithTerminal(String(s._id)).catch((err) => console.error("[shipment-jobs] booking failed", err));
    }

    await refreshWallet({ alert: true });
  } catch (err) {
    console.error("[shipment-jobs] run failed", err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

export function startShipmentJobs(): void {
  const seconds = env.terminal.pollIntervalSeconds;
  if (!isTerminalConfigured || !seconds || seconds <= 0) return;
  const timer = setInterval(() => void runShipmentJobs(), Math.max(60, seconds) * 1000);
  timer.unref();
  console.log(`[shipment-jobs] polling Terminal every ${Math.max(60, seconds)}s`);
}
