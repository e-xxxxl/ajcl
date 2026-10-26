import { env, maskSecret } from "../env";

/**
 * Thin HTTP client for the Terminal Africa REST API. Server-side only: the secret key never
 * leaves this process. Every call is logged (method, path, status, duration) without the key
 * or any request body, and every failure becomes a TerminalError the callers can reason about.
 */

export class TerminalError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** The carrier wallet could not cover this booking. Needs a top-up, then a retry. */
  readonly walletLow: boolean;
  /** Worth trying again later (network trouble, timeouts, 5xx, rate limiting). */
  readonly retryable: boolean;

  constructor(message: string, opts: { status?: number; body?: unknown; retryable?: boolean } = {}) {
    super(message);
    this.name = "TerminalError";
    this.status = opts.status ?? 0;
    this.body = opts.body;
    this.walletLow = looksLikeLowWallet(message, this.status);
    this.retryable = opts.retryable ?? (this.status === 0 || this.status === 429 || this.status >= 500);
  }
}

/** Terminal's exact insufficient-funds response is not documented, so match on the wording. */
export function looksLikeLowWallet(message: string, status = 0): boolean {
  if (status === 402) return true;
  return /insufficient|not enough|low (wallet )?balance|fund(s|ing)?\b.*(wallet|account)|wallet.*(fund|balance|top)/i.test(message);
}

export class TerminalNotConfiguredError extends TerminalError {
  constructor() {
    super("Terminal Africa is not configured. Set TERMINAL_AFRICA_SECRET_KEY.", { retryable: false });
    this.name = "TerminalNotConfiguredError";
  }
}

type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
};

/** Returns the response's `data` field. */
export async function terminalRequest<T = unknown>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  if (!env.terminal.secretKey) throw new TerminalNotConfiguredError();

  const url = new URL(`${env.terminal.url}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25_000);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${env.terminal.secretKey}`,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    console.error(`[terminal] ${method} ${path} failed after ${Date.now() - started}ms: ${aborted ? "timeout" : String(err)}`);
    throw new TerminalError(aborted ? "Terminal Africa took too long to respond." : "Could not reach Terminal Africa.", {
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: { status?: boolean; message?: string; data?: unknown } | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  console.info(`[terminal] ${method} ${path} -> ${res.status} (${Date.now() - started}ms)`);
  if (env.terminal.debug) {
    // The secret key is a header and is never logged. Bodies hold the addresses and parcel exactly as Terminal received them.
    console.info(`[terminal:debug] ${method} ${url.pathname}${url.search}\n  request: ${opts.body === undefined ? "(none)" : JSON.stringify(opts.body)}\n  response: ${text.slice(0, 30000)}`);
  }

  if (!res.ok || (json && json.status === false)) {
    const message = (json && typeof json.message === "string" && json.message) || `Terminal Africa returned ${res.status}.`;
    console.error(`[terminal] ${method} ${path} error ${res.status}: ${message}`);
    throw new TerminalError(message, { status: res.status || 400, body: json ?? text.slice(0, 500) });
  }
  return (json?.data ?? json) as T;
}

/**
 * A test key (sk_test_...) only works on the sandbox host and a live key (sk_live_...) only on the live host.
 * Mixing them gives "Invalid token" or "Account not active", which looks like an account problem but is a setup one.
 */
export function keyEnvironmentMismatch(): string | null {
  const key = env.terminal.secretKey ?? "";
  const sandboxHost = /sandbox/i.test(env.terminal.url);
  if (/^sk_live_/i.test(key) && sandboxHost) {
    return "This is a LIVE key but TERMINAL_AFRICA_URL is the sandbox. Use https://api.terminal.africa for a live key.";
  }
  if (/^sk_test_/i.test(key) && !sandboxHost) {
    return "This is a TEST key but TERMINAL_AFRICA_URL is the live host. Use https://sandbox.terminal.africa for a test key.";
  }
  return null;
}

export type TerminalPing = {
  ok: boolean;
  baseUrl: string;
  keyMasked: string;
  sandbox: boolean;
  status: number;
  message: string;
};

/** One cheap read-only call (the countries list) to show whether the key, URL and account work. */
export async function terminalPing(): Promise<TerminalPing> {
  const base = { baseUrl: env.terminal.url, keyMasked: maskSecret(env.terminal.secretKey), sandbox: /sandbox/i.test(env.terminal.url) };
  if (!env.terminal.secretKey) return { ...base, ok: false, status: 0, message: "TERMINAL_AFRICA_SECRET_KEY is not set on the server." };
  const mismatch = keyEnvironmentMismatch();
  if (mismatch) return { ...base, ok: false, status: 0, message: mismatch };
  try {
    const data = await terminalRequest<unknown[]>("GET", "/countries", { timeoutMs: 15_000 });
    return { ...base, ok: true, status: 200, message: `Connected. ${Array.isArray(data) ? data.length : 0} countries available.` };
  } catch (err) {
    if (err instanceof TerminalError) return { ...base, ok: false, status: err.status, message: err.message };
    return { ...base, ok: false, status: 0, message: err instanceof Error ? err.message : "Unknown error" };
  }
}
