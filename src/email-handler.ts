/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// email-handler.ts — Cloudflare Email Routing inbound email handler
// Parses incoming emails for trading signals and forwards them to trade-worker

import PostalMime from "postal-mime";
import {
  createLogger,
  safeWaitUntil,
} from "@hoox-sh/hoox-shared/middleware";
import {
  authenticatedServiceFetch,
  TRADE_EXECUTE_AUTH_KEY_FIELDS,
  resolveInternalAuthKey,
} from "@hoox-sh/hoox-shared/service-bindings";
import { trackAnalytics } from "@hoox-sh/hoox-shared/analytics";
import { loadSignalPatterns, parseEmailSignal } from "./index";
import type { Env } from "./index";

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
    if (!resolveInternalAuthKey(env, TRADE_EXECUTE_AUTH_KEY_FIELDS)) {
      logger.error("Trade execute auth key not configured");
      return;
    }

    if (!env.TRADE_SERVICE) {
      logger.error("TRADE_SERVICE binding not configured");
      return;
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

    // Track analytics (non-blocking)
    safeWaitUntil(
      ctx,
      trackAnalytics(env, "/track/signal", {
        data: {
          source: "email-worker",
          type: signal.action,
          symbol: signal.symbol,
          confidence: 0.5,
        },
      }),
      (err) => logger.error("trackAnalytics failed", { error: String(err) })
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
