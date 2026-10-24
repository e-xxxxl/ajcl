import { env } from "../env";
import { terminalRequest, TerminalError } from "./client";

/**
 * The handful of Terminal Africa operations AJCL uses, in our own vocabulary. Routes and
 * services depend on the TerminalApi interface, so tests can swap in a fake with
 * setTerminalForTests (the same pattern as the Cloudinary client).
 */

export type TerminalParty = {
  name: string;
  phone: string;
  email?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  country: string;
  zip?: string;
};

export type TerminalItem = {
  description: string;
  quantity: number;
  /** Value of one unit. */
  value: number;
  currency: string;
  weightKg: number;
};

/** Just enough of an address to price a route. */
export type TerminalQuoteAddress = { city: string; state: string; country: string; zip?: string };

export type TerminalRate = {
  rateId: string;
  carrierName: string;
  carrierLogo?: string;
  service?: string;
  deliveryTime?: string;
  amount: number;
  currency: string;
};

export type TerminalEvent = {
  eventId?: string;
  status: string;
  description?: string;
  location?: string;
  at: Date;
};

export type TerminalShipmentInfo = {
  shipmentId: string;
  status: string;
  carrierName?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  events: TerminalEvent[];
};

export type TerminalCountry = { code: string; name: string; phonecode?: string };
export type TerminalState = { code: string; name: string };
export type TerminalCity = { name: string };

export type TerminalWebhook = { id: string; name?: string; url: string; events: string[]; active: boolean; live: boolean };

export interface TerminalApi {
  listCountries(): Promise<TerminalCountry[]>;
  listStates(countryCode: string): Promise<TerminalState[]>;
  listCities(countryCode: string, stateCode: string): Promise<TerminalCity[]>;
  createAddress(party: TerminalParty): Promise<string>;
  createPackaging(input: { weightKg: number; lengthCm?: number; widthCm?: number; heightCm?: number; name: string }): Promise<string>;
  createParcel(input: { packagingId: string; items: TerminalItem[]; description?: string }): Promise<string>;
  createShipment(input: { fromAddressId: string; toAddressId: string; parcelId: string; purpose: "commercial" | "personal"; reference?: string }): Promise<{ shipmentId: string }>;
  listWebhooks(): Promise<TerminalWebhook[]>;
  createWebhook(input: { name: string; url: string; events: string[]; live: boolean }): Promise<TerminalWebhook>;
  getRates(input: { shipmentId: string; currency: string }): Promise<TerminalRate[]>;
  /** Prices a route without creating anything in Terminal. The rates cannot be booked; they are for showing a price. */
  getQuotes(input: { from: TerminalQuoteAddress; to: TerminalQuoteAddress; weightKg: number; currency: string }): Promise<TerminalRate[]>;
  bookShipment(input: { shipmentId: string; rateId: string }): Promise<TerminalShipmentInfo>;
  track(shipmentId: string): Promise<TerminalShipmentInfo>;
  getWalletBalance(): Promise<{ amount: number; currency: string }>;
}

/* ── helpers for the loosely documented response shapes ───────────────── */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  const first = parts.shift() || "-";
  return { first, last: parts.join(" ") || first };
}

function mapEvents(raw: unknown): TerminalEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObj).map((e) => ({
    eventId: str(e.id) ?? str(e.event_id),
    status: str(e.status) ?? "update",
    description: str(e.description),
    location: str(e.location),
    at: new Date(str(e.created_at) ?? str(e.date) ?? Date.now()),
  }));
}

export function mapShipment(raw: unknown): TerminalShipmentInfo {
  const d = isObj(raw) ? raw : {};
  const extras = isObj(d.extras) ? d.extras : {};
  const carrier = isObj(d.carrier) ? d.carrier : {};
  return {
    shipmentId: str(d.shipment_id) ?? str(d.id) ?? "",
    status: str(d.status) ?? "unknown",
    carrierName: str(carrier.name) ?? str(carrier.carrier_name) ?? str(extras.carrier_name),
    trackingNumber: str(extras.tracking_number) ?? str(d.carrier_tracking_number) ?? str(d.tracking_number),
    trackingUrl: str(extras.tracking_url) ?? str(d.tracking_url),
    events: mapEvents(d.events),
  };
}

function mapWebhook(w: Obj): TerminalWebhook {
  return {
    id: str(w.webhook_id) ?? str(w.id) ?? "",
    name: str(w.name),
    url: str(w.url) ?? "",
    events: Array.isArray(w.events) ? w.events.filter((e): e is string => typeof e === "string") : [],
    active: w.active !== false,
    live: w.live === true,
  };
}

function mapRate(raw: Obj): TerminalRate | null {
  const rateId = str(raw.rate_id) ?? str(raw.id);
  const amount = num(raw.amount);
  // Users without pricing permission get amount: null. Such a rate is of no use to us.
  if (!rateId || amount === undefined) return null;
  return {
    rateId,
    carrierName: str(raw.carrier_name) ?? "Carrier",
    carrierLogo: str(raw.carrier_logo),
    service: str(raw.carrier_rate_description),
    deliveryTime: str(raw.delivery_time),
    amount,
    currency: (str(raw.currency) ?? "NGN").toUpperCase(),
  };
}

/* ── the real implementation ──────────────────────────────────────────── */

const parcelAlternates = new Map<string, string>();
export const PARCEL_NOT_FOUND = /parcel.*(not|could not).*found|could not be found/i;

const realApi: TerminalApi = {
  async listCountries() {
    const data = await terminalRequest<unknown>("GET", "/countries");
    const list = Array.isArray(data) ? data : [];
    return list
      .filter(isObj)
      .map((c) => ({ code: (str(c.isoCode) ?? "").toUpperCase(), name: str(c.name) ?? "", phonecode: str(c.phonecode) }))
      .filter((c) => c.code && c.name);
  },

  async listStates(countryCode) {
    const data = await terminalRequest<unknown>("GET", "/states", { query: { country_code: countryCode } });
    const list = Array.isArray(data) ? data : [];
    return list
      .filter(isObj)
      .map((s) => ({ code: str(s.isoCode) ?? "", name: str(s.name) ?? "" }))
      .filter((s) => s.code && s.name);
  },

  async listCities(countryCode, stateCode) {
    const data = await terminalRequest<unknown>("GET", "/cities", { query: { country_code: countryCode, state_code: stateCode } });
    const list = Array.isArray(data) ? data : [];
    return list
      .filter(isObj)
      .map((c) => ({ name: str(c.name) ?? "" }))
      .filter((c) => c.name);
  },

  async createAddress(p) {
    const { first, last } = splitName(p.name);
    const data = await terminalRequest<Obj>("POST", "/addresses", {
      body: {
        first_name: first,
        last_name: last,
        email: p.email || undefined,
        phone: p.phone,
        line1: p.line1,
        line2: p.line2 || undefined,
        city: p.city,
        state: p.state,
        country: p.country,
        zip: p.zip || undefined,
        is_residential: true,
      },
    });
    const id = str(data.address_id) ?? str(data.id);
    if (!id) throw new TerminalError("Terminal Africa did not return an address id.");
    return id;
  },

  async createPackaging(input) {
    const data = await terminalRequest<Obj>("POST", "/packaging", {
      body: {
        name: input.name,
        type: "box",
        length: input.lengthCm ?? 30,
        width: input.widthCm ?? 30,
        height: input.heightCm ?? 30,
        size_unit: "cm",
        weight: input.weightKg,
        weight_unit: "kg",
      },
    });
    const id = str(data.packaging_id) ?? str(data.id);
    if (!id) throw new TerminalError("Terminal Africa did not return a packaging id.");
    return id;
  },

  async createParcel(input) {
    const data = await terminalRequest<Obj>("POST", "/parcels", {
      body: {
        packaging: input.packagingId,
        weight_unit: "kg",
        description: input.description,
        items: input.items.map((i) => ({
          name: i.description.slice(0, 60),
          description: i.description,
          type: "parcel",
          currency: i.currency,
          value: i.value,
          quantity: i.quantity,
          weight: i.weightKg,
        })),
      },
    });
    // Terminal returns both a long `id` and a `PC-` parcel_id. Shipments are created from the PC- one;
    // the other is kept as a second try in case a deployment answers differently.
    const primary = str(data.parcel_id) ?? str(data.id);
    const other = str(data.id) ?? str(data.parcel_id);
    if (!primary) throw new TerminalError("Terminal Africa did not return a parcel id.");
    if (other && other !== primary) parcelAlternates.set(primary, other);
    return primary;
  },

  async createShipment(input) {
    const attempt = (parcel: string) =>
      terminalRequest<Obj>("POST", "/shipments", {
        body: {
          address_from: input.fromAddressId,
          address_to: input.toAddressId,
          parcel,
          shipment_purpose: input.purpose,
          // Our own reference travels with the shipment, so webhooks can be matched back to it.
          metadata: input.reference ? { reference: input.reference } : undefined,
        },
      });
    let data: Obj;
    try {
      data = await attempt(input.parcelId);
    } catch (err) {
      const alt = parcelAlternates.get(input.parcelId);
      if (!(err instanceof TerminalError) || !alt || !PARCEL_NOT_FOUND.test(err.message)) throw err;
      data = await attempt(alt);
    }
    const shipmentId = str(data.shipment_id) ?? str(data.id);
    if (!shipmentId) throw new TerminalError("Terminal Africa did not return a shipment id.");
    return { shipmentId };
  },

  async listWebhooks() {
    const data = await terminalRequest<unknown>("GET", "/webhooks");
    const list = Array.isArray(data) ? data : [];
    return list.filter(isObj).map(mapWebhook);
  },

  async createWebhook(input) {
    const data = await terminalRequest<Obj>("POST", "/webhooks", {
      body: { name: input.name, url: input.url, events: input.events, active: true, live: input.live },
    });
    return mapWebhook(data);
  },

  async getQuotes(input) {
    const place = (a: TerminalQuoteAddress) => ({ city: a.city, state: a.state, country: a.country, zip: a.zip || "100001" });
    const data = await terminalRequest<unknown>("POST", "/rates/shipment/quotes", {
      body: {
        pickup_address: place(input.from),
        delivery_address: place(input.to),
        parcel: {
          description: "General goods shipment",
          items: [
            {
              name: "Shipment item",
              description: "General goods shipment",
              type: "general",
              currency: input.currency,
              value: 100,
              quantity: 1,
              weight: input.weightKg,
              weight_unit: "kg",
            },
          ],
          packaging: "",
          weight_unit: "kg",
        },
        currency: input.currency,
      },
      timeoutMs: 45_000,
    });
    const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.rates) ? data.rates : [];
    return list.filter(isObj).map(mapRate).filter((r): r is TerminalRate => r !== null);
  },

  async getRates(input) {
    const data = await terminalRequest<unknown>("GET", "/rates/shipment", {
      query: { shipment_id: input.shipmentId, currency: input.currency },
    });
    const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.rates) ? data.rates : [];
    return list.filter(isObj).map(mapRate).filter((r): r is TerminalRate => r !== null);
  },

  async bookShipment(input) {
    const data = await terminalRequest<Obj>("POST", "/shipments/pickup", {
      body: { rate_id: input.rateId, shipment_id: input.shipmentId },
      // Booking charges the wallet. A retry after a timeout could double charge, so no auto retry here.
      timeoutMs: 45_000,
    });
    const info = mapShipment(data);
    return { ...info, shipmentId: info.shipmentId || input.shipmentId };
  },

  async track(shipmentId) {
    const data = await terminalRequest<Obj>("GET", `/shipments/track/${encodeURIComponent(shipmentId)}`);
    const info = mapShipment(data);
    return { ...info, shipmentId: info.shipmentId || shipmentId };
  },

  async getWalletBalance() {
    // The wallet endpoint wants the company account's Terminal user id. It is set once in env
    // (TERMINAL_AFRICA_USER_ID); we never look it up, and never create or check accounts per customer.
    const userId = env.terminal.userId;
    if (!userId) throw new TerminalError("Wallet balance is not tracked. Set TERMINAL_AFRICA_USER_ID to show it here.", { retryable: false });
    const data = await terminalRequest<Obj>("GET", "/users/wallet-balance", { query: { user_id: userId } });
    const amount = num(data.amount);
    if (amount === undefined) throw new TerminalError("Terminal Africa did not return a wallet balance.");
    return { amount, currency: (str(data.currency) ?? "NGN").toUpperCase() };
  },
};

let current: TerminalApi = realApi;

export function terminal(): TerminalApi {
  return current;
}

/** Swap in a fake (tests only). Pass null to restore the real client. */
export function setTerminalForTests(fake: TerminalApi | null) {
  current = fake ?? realApi;
}
