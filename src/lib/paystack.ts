import crypto from "node:crypto";
import { env, isPaystackConfigured } from "./env";

const BASE = "https://api.paystack.co";

export type PaystackInitResult = {
  reference: string;
  accessCode: string;
  authorizationUrl: string;
};

export type PaystackVerifyResult = {
  status: "success" | "failed" | "abandoned" | "pending";
  reference: string;
  amountMinor: number;
  currency: string;
  channel?: string;
  paidAt?: string;
  gatewayResponse?: string;
  raw: unknown;
};

async function paystackFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!env.paystackSecretKey) throw new Error("PAYSTACK_SECRET_KEY is not configured");
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.paystackSecretKey}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const json = (await res.json()) as { status: boolean; message: string; data: T };
  if (!res.ok || !json.status) {
    throw new Error(json.message || `Paystack request failed (${res.status})`);
  }
  return json.data;
}

export async function initializeTransaction(params: {
  email: string;
  amountMinor: number;
  reference: string;
  currency?: string;
  callbackUrl: string;
  metadata?: Record<string, unknown>;
}): Promise<PaystackInitResult> {
  const data = await paystackFetch<{
    reference: string;
    access_code: string;
    authorization_url: string;
  }>("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email: params.email,
      amount: params.amountMinor,
      reference: params.reference,
      currency: params.currency ?? env.paystackCurrency,
      callback_url: params.callbackUrl,
      metadata: params.metadata,
    }),
  });

  return {
    reference: data.reference,
    accessCode: data.access_code,
    authorizationUrl: data.authorization_url,
  };
}

export async function verifyTransaction(reference: string): Promise<PaystackVerifyResult> {
  const data = await paystackFetch<{
    status: string;
    reference: string;
    amount: number;
    currency: string;
    channel?: string;
    paid_at?: string;
    gateway_response?: string;
  }>(`/transaction/verify/${encodeURIComponent(reference)}`);

  const status =
    data.status === "success"
      ? "success"
      : data.status === "abandoned"
        ? "abandoned"
        : data.status === "failed"
          ? "failed"
          : "pending";

  return {
    status,
    reference: data.reference,
    amountMinor: data.amount,
    currency: data.currency,
    channel: data.channel,
    paidAt: data.paid_at,
    gatewayResponse: data.gateway_response,
    raw: data,
  };
}

/** Verify the `x-paystack-signature` header (HMAC SHA512 of the raw body). */
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  if (!signature || !env.paystackSecretKey) return false;
  const hash = crypto
    .createHmac("sha512", env.paystackSecretKey)
    .update(rawBody, "utf8")
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
  } catch {
    return false;
  }
}

export { isPaystackConfigured };
