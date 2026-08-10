/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// email-worker/src/index.ts - Scans email inbox and forwards signals to trade-worker

import {
  Errors,
  createJsonResponse,
} from "@hoox-sh/hoox-shared/errors";
import {
  createLogger,
  withRequestLog,
  createInternalAuthMiddleware,
  validateJson,
  timingSafeEqual,
} from "@hoox-sh/hoox-shared/middleware";
import {
  createRouter,
  type MiddlewareHandler,
} from "@hoox-sh/hoox-shared/router";

import { trackAnalytics } from "@hoox-sh/hoox-shared/analytics";
import type { AnalyticsEnv } from "@hoox-sh/hoox-shared/analytics";
import { healthCheck } from "@hoox-sh/hoox-shared/health";
import { KVKeys } from "@hoox-sh/hoox-shared/kvKeys";
import {
  authenticatedServiceFetch,
  TRADE_EXECUTE_AUTH_KEY_FIELDS,
  resolveInternalAuthKey,
} from "@hoox-sh/hoox-shared/service-bindings";
import { z } from "zod";

const logger = createLogger({ service: "email-worker" });

export interface Env extends Cloudflare.Env, AnalyticsEnv {}

interface EmailSignal {
  exchange: string;
  /** Trade-worker action vocabulary: LONG | SHORT */
  action: "LONG" | "SHORT";
  symbol: string;
  quantity: number;
  price?: number;
  leverage?: number;
  /** When true, execute against exchange testnet/sandbox (if supported). */
  test?: boolean;
}

// ── Zod validation schemas ──────────────────────────────────────────

// Accept both email-native (buy/sell) and trade-worker (LONG/SHORT) vocabulary.
// Normalized to TradeActionSchema values before forwarding.
const EmailSignalSchema = z
  .object({
    exchange: z.string().min(1),
    action: z.enum(["buy", "sell", "long", "short", "LONG", "SHORT"]),
    symbol: z
      .string()
      .min(1)
      .max(32)
      .transform((s) => s.toUpperCase().replace(/[^A-Z0-9]/g, ""))
      .refine((s) => s.length >= 2, { message: "symbol too short" }),
    quantity: z
      .number()
      .finite()
      .positive()
      .max(1e12)
      .default(100),
    price: z.number().finite().positive().optional(),
    leverage: z.number().finite().positive().max(125).optional(),
    test: z.boolean().optional(),
  })
  .strip();

const WebhookPayloadSchema = z.object({
  subject: z.string().optional(),
  text: z.string().optional(),
  body: z.string().optional(),
});

// ── Constants ───────────────────────────────────────────────────────

/** Reject Mailgun signatures older/newer than this window (replay protection). */
export const MAILGUN_TIMESTAMP_TOLERANCE_SEC = 15 * 60;

// ── Router setup ────────────────────────────────────────────────────

const router = createRouter<Env>();
// Cast: createInternalAuthMiddleware returns MiddlewareHandler<InternalAuthEnv>
// but our router is typed for MiddlewareHandler<Env>. The middleware only
// reads `INTERNAL_KEY_BINDING` which is present on both types.
const requireAuth =
  createInternalAuthMiddleware() as unknown as MiddlewareHandler<Env>;

router.get("/health", async (_request, _env, _ctx) => {
  return healthCheck({ worker: "email-worker" });
});

router.post("/webhook", async (request, env, ctx) => {
  return await handleMailgunWebhook(request, env, ctx);
});

router.post(
  "/email-signal",
  async (request, env, ctx) => {
    return await handleDirectJson(request, env, ctx);
  },
  [requireAuth]
);

export default {
  fetch: withRequestLog(
    (request: Request, env: Env, ctx: ExecutionContext) => {
      return router.handle(request, env, ctx);
    },
    { service: "email-worker", module: "router" }
  ),

  async scheduled(
    _controller: ScheduledController,
    _env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    // IMAP scanning is NOT available in Cloudflare Workers edge runtime.
    // Primary ingestion paths: Mailgun webhook (POST /webhook) and
    // Cloudflare Email Routing (email handler). No scheduled polling needed.
    //
    // This scheduled handler exists so the cron trigger in wrangler.jsonc
    // doesn't cause "no scheduled handler" warnings. It performs lightweight
    // maintenance: refreshes the pattern cache from CONFIG_KV.
    logger.info("Scheduled: refreshing signal patterns cache");
    cachedPatterns = null; // invalidate cache so next parseEmailSignal reloads from KV
  },

  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const { emailHandler } = await import("./email-handler");
    return emailHandler(message, env, ctx);
  },
};

// ── Handlers ────────────────────────────────────────────────────────

/**
 * Verify Mailgun HMAC-SHA256 signature and timestamp freshness.
 * Fail-closed: missing key, stale/future timestamp, or mismatch → reject.
 *
 * @param nowSec - optional clock override for tests
 */
export async function verifyMailgunSignature(params: {
  signature: string;
  timestamp: string;
  token: string;
  apiKey: string;
  nowSec?: number;
  toleranceSec?: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const {
    signature,
    timestamp,
    token,
    apiKey,
    nowSec = Math.floor(Date.now() / 1000),
    toleranceSec = MAILGUN_TIMESTAMP_TOLERANCE_SEC,
  } = params;

  if (!apiKey) {
    return { ok: false, reason: "MAILGUN_API_KEY not configured" };
  }

  // Replay protection: reject stale or far-future timestamps
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || !/^\d{1,12}$/.test(timestamp.trim())) {
    return { ok: false, reason: "Invalid Mailgun timestamp" };
  }
  if (Math.abs(nowSec - ts) > toleranceSec) {
    return { ok: false, reason: "Mailgun timestamp outside allowed window" };
  }

  const dataToSign = timestamp + token;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(dataToSign)
  );
  const expectedSignature = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (!timingSafeEqual(signature, expectedSignature)) {
    return { ok: false, reason: "Invalid signature" };
  }
  return { ok: true };
}

async function handleMailgunWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const signature = request.headers.get("Mailgun-Signature");
  const timestamp = request.headers.get("Mailgun-Timestamp");
  const token = request.headers.get("Mailgun-Token");

  if (!signature || !timestamp || !token) {
    return Errors.unauthorized("Missing Mailgun signature headers");
  }

  const apiKey = env.MAILGUN_API_KEY;
  if (!apiKey) {
    logger.error("MAILGUN_API_KEY not configured");
    return Errors.internal("Service configuration error");
  }

  const verified = await verifyMailgunSignature({
    signature,
    timestamp,
    token,
    apiKey,
  });
  if (!verified.ok) {
    if (verified.reason === "MAILGUN_API_KEY not configured") {
      logger.error(verified.reason);
      return Errors.internal("Service configuration error");
    }
    logger.warn("Mailgun signature rejected", { reason: verified.reason });
    return Errors.unauthorized(verified.reason);
  }

  try {
    const formData = await request.formData();
    const body =
      formData.get("body-plain")?.toString() ||
      formData.get("stripped-text")?.toString() ||
      "";
    return await processEmail(body, "mailgun", env, ctx);
  } catch (error: unknown) {
    return Errors.internal(error);
  }
}

async function handleDirectJson(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const json = await request.json();
    const parsed = validateJson(WebhookPayloadSchema, json);
    if (!parsed.ok) {
      return Errors.badRequest(parsed.error);
    }
    const { text, body } = parsed.value;
    const emailBody = text || body || JSON.stringify(parsed.value);
    return await processEmail(emailBody, "json", env, ctx);
  } catch (error: unknown) {
    return Errors.internal(error);
  }
}

// ── Signal processing ───────────────────────────────────────────────

async function processEmail(
  body: string,
  source: string,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const signalPatterns = await loadSignalPatterns(env);

  let errorResponse: Response | null = null;
  const signal = parseEmailSignal(body, signalPatterns, {
    set: (resp) => {
      errorResponse = resp;
    },
  });

  if (errorResponse) return errorResponse;
  if (!signal) {
    return Errors.badRequest("No valid signal in email");
  }

  return processSignal(signal, env, ctx);
}

async function processSignal(
  signal: EmailSignal,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  logger.info("Email signal processed", { signal });

  try {
    if (!resolveInternalAuthKey(env, TRADE_EXECUTE_AUTH_KEY_FIELDS)) {
      logger.error("Trade execute auth key not configured");
      return Errors.internal("Trade execute auth key not configured");
    }

    if (!env.TRADE_SERVICE) {
      logger.error("TRADE_SERVICE binding not configured");
      return Errors.internal("Trade service not configured");
    }

    const mode = signal.test === true ? "test" : "live";
    const idempotencyKey = `email:${signal.exchange}:${signal.symbol}:${signal.action}:${signal.quantity}:${mode}`;
    const response = await authenticatedServiceFetch(
      env.TRADE_SERVICE,
      env,
      "/webhook",
      signal,
      {
        headers: {
          "X-Source": "email-worker",
          "Idempotency-Key": idempotencyKey,
        },
        internalKeyFields: TRADE_EXECUTE_AUTH_KEY_FIELDS,
      }
    );

    if (!response.ok) {
      // Track failed signal forwarding (non-blocking)
      ctx.waitUntil(
        trackAnalytics(env, "/track/signal", {
          data: {
            source: "email-worker",
            type: signal.action,
            symbol: signal.symbol,
            confidence: 0.5,
          },
        }).catch((err) =>
          logger.error("trackAnalytics failed", { error: String(err) })
        )
      );

      return Errors.internal(`Trade worker error: ${response.status}`);
    }

    const result = (await response.json()) as { requestId?: string };

    // Track successful signal forwarding (non-blocking)
    ctx.waitUntil(
      trackAnalytics(env, "/track/signal", {
        data: {
          source: "email-worker",
          type: signal.action,
          symbol: signal.symbol,
          confidence: 0.5,
        },
      }).catch((err) =>
        logger.error("trackAnalytics failed", { error: String(err) })
      )
    );

    return createJsonResponse(
      { success: true, requestId: result.requestId },
      200
    );
  } catch (error: unknown) {
    return Errors.internal(error);
  }
}

// ── Signal parsing ──────────────────────────────────────────────────

export interface SignalPatterns {
  coinPattern: RegExp;
  actionPattern: RegExp;
  quantityMultiplier: number;
}

export type { EmailSignal };

// ── Pattern cache ───────────────────────────────────────────────────
let cachedPatterns: {
  patterns: SignalPatterns;
  expiresAt: number;
} | null = null;
const PATTERN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Compile a KV-sourced regex with ReDoS / injection guards.
 * Rejects oversized sources, dangerous constructs, and invalid syntax;
 * falls back to a known-safe default pattern.
 */
export function compileSafePattern(source: string, fallback: string): RegExp {
  const MAX_LEN = 128;
  // Allow only alternation of simple tokens (letters, digits, |, +, -, _, space).
  // Disallow nested quantifiers, lookaround, and backreferences that enable ReDoS.
  const SAFE = /^[A-Za-z0-9|_\-+ ]{1,128}$/;
  const src = (source || "").trim();
  const candidate =
    src.length > 0 && src.length <= MAX_LEN && SAFE.test(src) ? src : fallback;
  try {
    return new RegExp(candidate, "i");
  } catch {
    return new RegExp(fallback, "i");
  }
}

export async function loadSignalPatterns(env: Env): Promise<SignalPatterns> {
  const now = Date.now();
  if (cachedPatterns && now < cachedPatterns.expiresAt) {
    return cachedPatterns.patterns;
  }

  const [coinPattern, actionPattern, quantityMultiplier] = await Promise.all([
    env.CONFIG_KV?.get(KVKeys.KV_EMAIL_COIN_PATTERN).then(
      (v) => v || "BTC|ETH|SOL"
    ),
    env.CONFIG_KV?.get(KVKeys.KV_EMAIL_ACTION_PATTERN).then(
      (v) => v || "buy|sell|long|short"
    ),
    env.CONFIG_KV?.get(KVKeys.KV_EMAIL_QUANTITY_MULTIPLIER).then((v) =>
      v ? parseFloat(v) : 1
    ),
  ]);

  const mult =
    typeof quantityMultiplier === "number" &&
    Number.isFinite(quantityMultiplier) &&
    quantityMultiplier > 0
      ? quantityMultiplier
      : 1;

  const patterns = {
    coinPattern: compileSafePattern(String(coinPattern), "BTC|ETH|SOL"),
    actionPattern: compileSafePattern(
      String(actionPattern),
      "buy|sell|long|short"
    ),
    quantityMultiplier: mult,
  };

  cachedPatterns = {
    patterns,
    expiresAt: now + PATTERN_CACHE_TTL_MS,
  };

  return patterns;
}

export function parseEmailSignal(
  body: string,
  patterns: SignalPatterns,
  signalError?: { set: (resp: Response) => void }
): EmailSignal | null {
  // Only attempt structured JSON when the body looks like a JSON object/array.
  // Avoid treating free text that happens to contain `{` mid-string as JSON.
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = EmailSignalSchema.safeParse(JSON.parse(trimmed));
      if (!parsed.success) {
        if (signalError) {
          signalError.set(
            createJsonResponse({ error: "Invalid signal format" }, 400)
          );
        }
        return null;
      }
      const data = parsed.data;
      const normalizedExchange = normalizeExchange(data.exchange);
      if (!normalizedExchange) {
        if (signalError) {
          signalError.set(
            createJsonResponse({ error: "Unsupported exchange" }, 400)
          );
        }
        return null;
      }
      const quantity = data.quantity * patterns.quantityMultiplier;
      if (!Number.isFinite(quantity) || quantity <= 0) {
        if (signalError) {
          signalError.set(
            createJsonResponse({ error: "Invalid quantity" }, 400)
          );
        }
        return null;
      }
      return {
        exchange: normalizedExchange,
        action: normalizeAction(data.action),
        symbol: data.symbol,
        quantity,
        price: data.price,
        leverage: data.leverage,
        test: data.test,
      };
    } catch {
      // Malformed JSON that looked like JSON — fall through to plaintext
    }
  }
  return extractFromPlaintext(body, patterns);
}

function extractFromPlaintext(
  body: string,
  patterns: SignalPatterns
): EmailSignal | null {
  const lower = body.toLowerCase();

  const symbolMatch = lower.match(patterns.coinPattern);
  const actionMatch = lower.match(patterns.actionPattern);

  const exchange = extractField(lower, [
    "exchange",
    "binance",
    "mexc",
    "bybit",
  ]);
  const symbol = symbolMatch
    ? symbolMatch[0].toUpperCase()
    : extractField(lower, ["symbol", "pair"]);
  const action = actionMatch
    ? normalizeAction(actionMatch[0])
    : extractField(lower, ["action", "buy", "sell", "long", "short"]);

  // Optional quantity: "quantity: 1.5" (plain) — default 100 when absent
  const quantityRaw = extractNumericField(lower, ["quantity", "qty", "size"]);
  const baseQty =
    quantityRaw !== null && Number.isFinite(quantityRaw) && quantityRaw > 0
      ? quantityRaw
      : 100;
  const quantity = baseQty * patterns.quantityMultiplier;
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }

  const normalizedExchange = exchange ? normalizeExchange(exchange) : null;
  const normalizedAction = action ? normalizeAction(action) : null;
  const cleanSymbol = symbol
    ? symbol.toUpperCase().replace(/[^A-Z0-9]/g, "")
    : "";
  if (
    normalizedExchange &&
    normalizedAction &&
    cleanSymbol &&
    cleanSymbol.length >= 2
  ) {
    return {
      exchange: normalizedExchange,
      action: normalizedAction,
      symbol: cleanSymbol,
      quantity,
    };
  }
  return null;
}

function extractField(body: string, keywords: string[]): string | null {
  for (const kw of keywords) {
    const idx = body.indexOf(kw + ":");
    if (idx !== -1) {
      const after = body.substring(idx + kw.length + 1).trim();
      return after
        .split(/[\n\r,;]/)[0]
        .trim()
        .replace(/[^a-zA-Z0-9]/g, "");
    }
  }
  return null;
}

/** Extract a numeric field value (preserves decimals; rejects non-finite). */
function extractNumericField(body: string, keywords: string[]): number | null {
  for (const kw of keywords) {
    const idx = body.indexOf(kw + ":");
    if (idx !== -1) {
      const after = body.substring(idx + kw.length + 1).trim();
      const token = after.split(/[\n\r,;\s]/)[0]?.trim() ?? "";
      const n = parseFloat(token);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function normalizeExchange(value: string): string | null {
  const v = value.toLowerCase();
  if (v.includes("binance")) return "binance";
  if (v.includes("mexc")) return "mexc";
  if (v.includes("bybit")) return "bybit";
  return null;
}

/**
 * Map email / free-text action vocabulary onto trade-worker actions.
 * WebhookPayloadSchema requires LONG | SHORT | CLOSE_*.
 */
function normalizeAction(value: string): "LONG" | "SHORT" {
  const v = value.toLowerCase();
  if (v.includes("buy") || v.includes("long")) return "LONG";
  if (v.includes("sell") || v.includes("short")) return "SHORT";
  // Default: treat unknown as SHORT is wrong — throw to caller via filter.
  // Callers only pass buy/sell/long/short from patterns; fall back to LONG
  // only for the residual enum path that already matched the schema.
  return v.startsWith("s") ? "SHORT" : "LONG";
}
