// email-worker/src/index.ts - Scans email inbox and forwards signals to trade-worker

import type { Fetcher } from "@cloudflare/workers-types";
import type { KVNamespace } from "@cloudflare/workers-types";
import { createErrorResponse, Errors } from '@hoox/shared/errors';
import type { StandardResponse } from '@hoox/shared/types';

interface Env {
  CONFIG_KV?: KVNamespace;
  EMAIL_HOST_BINDING?: string;
  EMAIL_USER_BINDING?: string;
  EMAIL_PASS_BINDING?: string;
  INTERNAL_KEY_BINDING?: string;
  MAILGUN_API_KEY?: string;
  TRADE_SERVICE: Fetcher;
  ANALYTICS_SERVICE?: Fetcher;
  EMAIL_SCAN_SUBJECT?: string;
  USE_IMAP?: string;
}

interface EmailSignal {
  exchange: string;
  action: string;
  symbol: string;
  quantity: number;
  price?: number;
  leverage?: number;
}

const DEFAULT_SCAN_SUBJECT = "Trading Signal";

// Analytics tracking helper
async function trackAnalytics(
  env: Env,
  endpoint: string,
  body: Record<string, any>
): Promise<void> {
  if (!env.ANALYTICS_SERVICE) return;
  try {
    await env.ANALYTICS_SERVICE.fetch(
      new Request("http://analytics-service" + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }) as any
    );
  } catch (e) {
    console.error("Analytics tracking failed:", e);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const contentType = request.headers.get("content-type") || "";
    const userAgent = request.headers.get("user-agent") || "";

    if (
      userAgent.includes("Mailgun") ||
      contentType.includes("application/x-www-form-urlencoded")
    ) {
      return await handleMailgunWebhook(request, env);
    }

    if (contentType.includes("application/json")) {
      return await handleDirectJson(request, env);
    }

    return new Response(
      "Email Worker Ready. POST email data or use webhooks.",
      {
        headers: { "Content-Type": "text/plain" },
      }
    );
  },

  async scheduled(env: Env): Promise<void> {
    if (env.USE_IMAP === "true") {
      await handleIMAPScan(env);
    }
  },
};

async function handleMailgunWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const signature = request.headers.get("Mailgun-Signature");
  const timestamp = request.headers.get("Mailgun-Timestamp");
  const token = request.headers.get("Mailgun-Token");

  if (!signature || !timestamp || !token) {
    return Errors.unauthorized("Missing Mailgun signature headers");
  }

  const apiKey = env.MAILGUN_API_KEY;
  if (!apiKey) {
    console.error("MAILGUN_API_KEY not configured");
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

  if (signature !== expectedSignature) {
    console.warn("Invalid Mailgun signature");
    return Errors.unauthorized("Invalid signature");
  }

  try {
    const formData = await request.formData();
    const subject = formData.get("subject")?.toString() || "";
    const body =
      formData.get("body-plain")?.toString() ||
      formData.get("stripped-text")?.toString() ||
      "";
    return await processEmail(subject, body, "mailgun", env);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleDirectJson(request: Request, env: Env): Promise<Response> {
  try {
    const json = (await request.json()) as Record<string, unknown>;
    const subject = json.subject?.toString() || "";
    const body =
      json.text?.toString() || json.body?.toString() || JSON.stringify(json);
    return await processEmail(subject, body, "json", env);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleIMAPScan(env: Env): Promise<Response> {
  try {
    const [host, user, pass, scanSubject] = await Promise.all([
      env.EMAIL_HOST_BINDING,
      env.EMAIL_USER_BINDING,
      env.EMAIL_PASS_BINDING,
      env.CONFIG_KV?.get("email:scan_subject") ||
        Promise.resolve(DEFAULT_SCAN_SUBJECT),
    ]);

    if (!host || !user || !pass) {
      return new Response("Error: Missing IMAP credentials", { status: 500 });
    }

    const useImap = await env.CONFIG_KV?.get("email:use_imap");
    if (useImap === "false") {
      console.log("[IMAP] IMAP polling disabled via KV config");
      return new Response("IMAP polling disabled", { status: 200 });
    }

    console.log(`[IMAP] Scanning ${user}@${host} for: ${scanSubject}`);
    throw new Error(
      "IMAP scanning requires the 'imap' package which is not available in Cloudflare Workers. Use Mailgun webhook or direct JSON instead."
    );
  } catch (error) {
    return errorResponse(error);
  }
}

async function processEmail(
  subject: string,
  body: string,
  source: string,
  env: Env
): Promise<Response> {
  const signalPatterns = await loadSignalPatterns(env);
  const signal = parseEmailSignal(body, signalPatterns);

  if (!signal) {
    return new Response(
      JSON.stringify({ success: false, error: "No valid signal in email" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  console.log(`[${source}] Signal: ${JSON.stringify(signal)}`);

  try {
    const internalKey = env.INTERNAL_KEY_BINDING;
    const response = await env.TRADE_SERVICE.fetch(
      "https://trade-worker.internal/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": internalKey || "",
          "X-Source": "email-worker",
        },
        body: JSON.stringify(signal),
      }
    );

    if (!response.ok) {
      // Track failed signal forwarding (non-blocking)
      trackAnalytics(env, "/track/signal", {
        data: {
          source: "email-worker",
          type: signal.action,
          symbol: signal.symbol,
          confidence: 0.5,
        },
      });

      return new Response(`Trade worker error: ${response.status}`, {
        status: 500,
      });
    }

    const result = (await response.json()) as { requestId?: string };

    // Track successful signal forwarding (non-blocking)
    trackAnalytics(env, "/track/signal", {
      data: {
        source: "email-worker",
        type: signal.action,
        symbol: signal.symbol,
        confidence: 0.5,
      },
    });

    return new Response(
      JSON.stringify({ success: true, requestId: result.requestId }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return errorResponse(error);
  }
}

interface SignalPatterns {
  coinPattern: RegExp;
  actionPattern: RegExp;
  quantityMultiplier: number;
}

async function loadSignalPatterns(env: Env): Promise<SignalPatterns> {
  const [coinPattern, actionPattern, quantityMultiplier] = await Promise.all([
    env.CONFIG_KV?.get("email:coin_pattern").then((v) => v || "BTC|ETH|SOL"),
    env.CONFIG_KV?.get("email:action_pattern").then(
      (v) => v || "BUY|SELL|LONG|SHORT"
    ),
    env.CONFIG_KV?.get("email:quantity_multiplier").then((v) =>
      v ? parseFloat(v) : 1
    ),
  ]);

  return {
    coinPattern: new RegExp(coinPattern as string, "i"),
    actionPattern: new RegExp(actionPattern as string, "i"),
    quantityMultiplier: quantityMultiplier ?? 1,
  };
}

function parseEmailSignal(
  body: string,
  patterns: SignalPatterns
): EmailSignal | null {
  try {
    const data = JSON.parse(body);
    if (data.exchange && data.action && data.symbol) {
      return {
        exchange: String(data.exchange).toLowerCase(),
        action: normalizeAction(String(data.action)),
        symbol: String(data.symbol).toUpperCase(),
        quantity: (Number(data.quantity) || 100) * patterns.quantityMultiplier,
        price: data.price ? Number(data.price) : undefined,
        leverage: data.leverage ? Number(data.leverage) : undefined,
      };
    }
  } catch {}
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

  if (exchange && action && symbol) {
    return {
      exchange: normalizeExchange(exchange),
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

function normalizeExchange(value: string): string {
  const v = value.toLowerCase();
  if (v.includes("binance")) return "binance";
  if (v.includes("mexc")) return "mexc";
  if (v.includes("bybit")) return "bybit";
  return v;
}

function normalizeAction(value: string): string {
  const v = value.toLowerCase();
  if (v.includes("buy") || v.includes("long")) return "buy";
  if (v.includes("sell") || v.includes("short")) return "sell";
  return v;
}

function errorResponse(error: unknown): Response {
  return new Response(
    `Error: ${error instanceof Error ? error.message : String(error)}`,
    {
      status: 500,
      headers: { "Content-Type": "application/json" },
    }
  );
}
