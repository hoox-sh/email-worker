/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Exercise pure helpers from @hoox-sh/hoox-shared already depended on by
 * email-worker (no network / real bindings).
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  toError,
  createJsonResponse,
  createSuccessResponse,
  createErrorResponse,
  Errors,
} from "@hoox-sh/hoox-shared/errors";
import { healthCheck } from "@hoox-sh/hoox-shared/health";
import {
  timingSafeEqual,
  checkInternalAuth,
  requireInternalAuth,
  createInternalAuthMiddleware,
  validateJson,
  validateJsonLegacy,
  requireField,
  optionalField,
  createLogger,
  withRequestLog,
  corsHeaders,
  publicCorsHeaders,
  internalCorsHeaders,
  resolveCorsOptions,
  handleCorsPreflightRequest,
  createRateLimiter,
  secureHeaders,
  wrapWithSecurityHeaders,
} from "@hoox-sh/hoox-shared/middleware";
import { createRouter } from "@hoox-sh/hoox-shared/router";
import {
  resolveInternalAuthKey,
  serviceFetch,
  authenticatedServiceFetch,
  TRADE_EXECUTE_AUTH_KEY_FIELDS,
} from "@hoox-sh/hoox-shared/service-bindings";
import { KVKeys } from "@hoox-sh/hoox-shared/kvKeys";
import { trackAnalytics } from "@hoox-sh/hoox-shared/analytics";

describe("shared errors + health", () => {
  test("toError variants", () => {
    expect(toError(new Error("e"))).toBe("e");
    expect(toError("s")).toBe("s");
    expect(toError({ message: "m" })).toBe("m");
    expect(toError(null, "fb")).toBe("fb");
  });

  test("response factories and Errors", async () => {
    expect((await createJsonResponse({ ok: 1 }, 201)).status).toBe(201);
    expect((await createSuccessResponse({ x: 1 })).status).toBe(200);
    expect((await createErrorResponse("x")).status).toBe(500);
    expect((await Errors.badRequest("b")).status).toBe(400);
    expect((await Errors.unauthorized("u")).status).toBe(401);
    expect((await Errors.forbidden()).status).toBe(403);
    expect((await Errors.notFound()).status).toBe(404);
    expect((await Errors.methodNotAllowed()).status).toBe(405);
    expect((await Errors.rateLimited()).status).toBe(429);
    expect((await Errors.internal(new Error("z"))).status).toBe(500);
  });

  test("healthCheck", async () => {
    const res = healthCheck({
      worker: "email-worker",
      version: "1",
      details: { mode: "test" },
    });
    expect(res.status).toBe(200);
  });
});

describe("shared middleware", () => {
  test("auth + validate", async () => {
    expect(timingSafeEqual("aa", "aa")).toBe(true);
    const env = { INTERNAL_KEY_BINDING: "k" } as any;
    const good = new Request("https://e", {
      headers: { "X-Internal-Auth-Key": "k" },
    });
    expect(checkInternalAuth(good, env).authorized).toBe(true);
    expect(requireInternalAuth(good, env)).toBeNull();
    expect(typeof createInternalAuthMiddleware()).toBe("function");

    const schema = z.object({ exchange: z.string() });
    expect(validateJson(schema, { exchange: "binance" }).ok).toBe(true);
    expect(validateJson(schema, {}).ok).toBe(false);
    expect(
      (
        await validateJsonLegacy(
          new Request("https://e", {
            method: "POST",
            body: JSON.stringify({ a: 1 }),
          })
        )
      ).ok
    ).toBe(true);
    expect(requireField({ a: 1 }, "missing").ok).toBe(false);
    expect(optionalField({ a: 1 }, "a", 0)).toBe(1);
  });

  test("cors security rate-limit logger", async () => {
    expect(corsHeaders({ allowOrigin: "https://o" })[
      "Access-Control-Allow-Origin"
    ]).toBe("https://o");
    expect(publicCorsHeaders("https://p")["Access-Control-Allow-Origin"]).toBe(
      "https://p"
    );
    expect(internalCorsHeaders()).toBeDefined();
    resolveCorsOptions(new Request("https://e"), {} as any);
    const pre = handleCorsPreflightRequest(
      new Request("https://e", { method: "OPTIONS" }),
      { allowOrigin: "https://o" }
    );
    expect(pre).not.toBeNull();
    expect(pre!.status).toBe(204);
    expect(secureHeaders()["X-Frame-Options"] || secureHeaders()).toBeDefined();
    wrapWithSecurityHeaders(new Response("ok"));

    const limiter = createRateLimiter(undefined, { maxRequests: 1, windowSeconds: 10 });
    const req = new Request("https://e", {
      headers: { "CF-Connecting-IP": "1.1.1.1" },
    });
    await limiter.check(req);
    expect((await limiter.enforce(req))?.status).toBe(429);

    const log = createLogger({ service: "email-worker" });
    log.info("i");
    log.warn("w");
    log.error("e");
    log.debug("d");
    const wrapped = withRequestLog(async () => new Response("ok"), {
      service: "email-worker",
    });
    expect(
      (
        await wrapped(
          new Request("https://e/webhook"),
          {} as any,
          { waitUntil: () => {} } as any
        )
      ).status
    ).toBe(200);
  });
});

describe("shared router bindings analytics kv", () => {
  test("router", async () => {
    const r = createRouter();
    r.post("/x", async () => new Response("ok"));
    expect(
      (
        await r.handle(
          new Request("https://e/x", { method: "POST" }),
          {} as any,
          {} as any
        )
      ).status
    ).toBe(200);
  });

  test("service bindings", async () => {
    expect(
      resolveInternalAuthKey(
        { INTERNAL_KEY_BINDING: "k" },
        TRADE_EXECUTE_AUTH_KEY_FIELDS
      )
    ).toBe("k");
    const binding = {
      fetch: async () =>
        new Response(JSON.stringify({ requestId: "1" }), { status: 200 }),
    };
    expect((await serviceFetch(binding as any, "/webhook")).ok).toBe(true);
    expect(
      (
        await authenticatedServiceFetch(
          binding as any,
          { INTERNAL_KEY_BINDING: "k" } as any,
          "/webhook",
          { exchange: "binance" },
          { internalKeyFields: TRADE_EXECUTE_AUTH_KEY_FIELDS }
        )
      ).ok
    ).toBe(true);
  });

  test("trackAnalytics no-ops without ANALYTICS_SERVICE", async () => {
    await trackAnalytics({} as any, "/track/signal", {
      data: { source: "email-worker", type: "LONG", symbol: "BTC", confidence: 0.5 },
    });
  });

  test("KVKeys email patterns exist", () => {
    expect(typeof KVKeys.KV_EMAIL_COIN_PATTERN).toBe("string");
    expect(typeof KVKeys.KV_EMAIL_ACTION_PATTERN).toBe("string");
  });
});
