// email-worker/src/index.ts - Scans email inbox and forwards signals to trade-worker

import {
  Errors,
  createJsonResponse,
} from "@jango-blockchained/hoox-shared/errors";
import {
  createLogger,
  withRequestLog,
  createInternalAuthMiddleware,
  validateJson,
  timingSafeEqual,
} from "@jango-blockchained/hoox-shared/middleware";
import {
  createRouter,
  type MiddlewareHandler,
} from "@jango-blockchained/hoox-shared/router";

import { trackAnalytics } from "@jango-blockchained/hoox-shared/analytics";
import type { AnalyticsEnv } from "@jango-blockchained/hoox-shared/analytics";
import { healthCheck } from "@jango-blockchained/hoox-shared/health";
import { KVKeys } from "@jango-blockchained/hoox-shared/kvKeys";
import { serviceFetch } from "@jango-blockchained/hoox-shared/service-bindings";
import { z } from "zod";

const logger = createLogger({ service: "email-worker" });

export interface Env extends Cloudflare.Env, AnalyticsEnv {}

interface EmailSignal {
  exchange: string;
  action: string;
  symbol: string;
  quantity: number;
  price?: number;
  leverage?: number;
}

// ── Zod validation schemas ──────────────────────────────────────────

const EmailSignalSchema = z
  .object({
    exchange: z.string(),
    action: z.enum(["buy", "sell"]),
    symbol: z.string(),
    quantity: z.number().default(100),
    price: z.number().optional(),
    leverage: z.number().optional(),
  })
  .strip();

const WebhookPayloadSchema = z.object({
  subject: z.string().optional(),
  text: z.string().optional(),
  body: z.string().optional(),
});

// ── Constants ───────────────────────────────────────────────────────

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
    logger.warn("Invalid Mailgun signature");
    return Errors.unauthorized("Invalid signature");
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
    const internalKey = env.INTERNAL_KEY_BINDING;

    if (!internalKey) {
      logger.error("INTERNAL_KEY_BINDING not configured");
      return Errors.internal("Internal authentication not configured");
    }

    if (!env.TRADE_SERVICE) {
      logger.error("TRADE_SERVICE binding not configured");
      return Errors.internal("Trade service not configured");
    }

    const response = await serviceFetch(env.TRADE_SERVICE, "/webhook", signal, {
      headers: {
        "X-Internal-Auth-Key": internalKey,
        "X-Source": "email-worker",
      },
    });

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

  const patterns = {
    coinPattern: new RegExp(coinPattern as string, "i"),
    actionPattern: new RegExp(actionPattern as string, "i"),
    quantityMultiplier: quantityMultiplier ?? 1,
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
  try {
    const parsed = EmailSignalSchema.safeParse(JSON.parse(body));
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
    if (!normalizedExchange) return null;
    return {
      exchange: normalizedExchange,
      action: data.action,
      symbol: data.symbol.toUpperCase(),
      quantity: data.quantity * patterns.quantityMultiplier,
      price: data.price,
      leverage: data.leverage,
    };
  } catch {
    // Not JSON — fall through to plaintext parsing
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

  const normalizedExchange = exchange ? normalizeExchange(exchange) : null;
  if (normalizedExchange && action && symbol) {
    return {
      exchange: normalizedExchange,
      action: normalizeAction(action),
      symbol: symbol.toUpperCase().replace(/[^A-Z0-9]/g, ""),
      quantity: 100 * patterns.quantityMultiplier,
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

function normalizeExchange(value: string): string | null {
  const v = value.toLowerCase();
  if (v.includes("binance")) return "binance";
  if (v.includes("mexc")) return "mexc";
  if (v.includes("bybit")) return "bybit";
  return null;
}

function normalizeAction(value: string): string {
  const v = value.toLowerCase();
  if (v.includes("buy") || v.includes("long")) return "buy";
  if (v.includes("sell") || v.includes("short")) return "sell";
  return v;
}
