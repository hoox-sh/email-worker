// email-handler.ts — Cloudflare Email Routing inbound email handler
// Parses incoming emails for trading signals and forwards them to trade-worker

import PostalMime from "postal-mime";
import { createLogger } from "@jango-blockchained/hoox-shared/middleware";
import { serviceFetch } from "@jango-blockchained/hoox-shared/service-bindings";
import { trackAnalytics } from "@jango-blockchained/hoox-shared/analytics";
import { loadSignalPatterns, parseEmailSignal } from "./index";
import type { Env, EmailSignal } from "./index";

const logger = createLogger({ service: "email-worker" });

export async function emailHandler(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  try {
    // Buffer raw content (message.raw is single-use ReadableStream)
    const rawBuffer = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(rawBuffer);
    const textBody = parsed.text || parsed.html || "";

    if (!textBody) {
      logger.info("Email Routing: no text content, skipping");
      return;
    }

    // Parse for trading signal
    const signalPatterns = await loadSignalPatterns(env);
    const signal = parseEmailSignal(textBody, signalPatterns);

    if (!signal) {
      logger.info(
        "Email Routing: no valid signal found in email from " + message.from
      );
      return;
    }

    logger.info("Email Routing signal parsed", {
      from: message.from,
      subject: parsed.subject,
      signal,
    });

    // Forward to trade-worker
    const internalKey = env.INTERNAL_KEY_BINDING;
    if (!internalKey) {
      logger.error("INTERNAL_KEY_BINDING not configured");
      return;
    }

    if (!env.TRADE_SERVICE) {
      logger.error("TRADE_SERVICE binding not configured");
      return;
    }

    const response = await serviceFetch(env.TRADE_SERVICE, "/webhook", signal, {
      headers: {
        "X-Internal-Auth-Key": internalKey,
        "X-Source": "email-worker",
      },
    });

    // Track analytics (non-blocking)
    ctx.waitUntil(
      trackAnalytics(env, "/track/signal", {
        data: {
          source: "email-worker",
          type: signal.action,
          symbol: signal.symbol,
          confidence: 0.5,
        },
      })
    );

    if (response.ok) {
      const result = (await response.json()) as { requestId?: string };
      logger.info("Email Routing signal forwarded to trade-worker", {
        requestId: result.requestId,
      });
    } else {
      logger.error("Email Routing: trade worker error", {
        status: response.status,
      });
    }
  } catch (error: unknown) {
    logger.error("Email Routing handler error", { error });
  }
}
