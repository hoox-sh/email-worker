/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test, vi } from "bun:test";
import { generateMailgunSignature } from "./helpers";
import worker from "../src/index";

describe("Email Worker fetch handler", () => {
  // Helper to create mock ExecutionContext
  const mockCtx = {
    waitUntil: vi.fn((p: Promise<any>) => {
      p?.catch?.(() => {});
    }),
    passThroughOnException: vi.fn(),
  } as any;

  test("should handle GET /health request", async () => {
    const req = new Request("http://localhost/health");
    const mockEnv = {} as any;
    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.result.service).toBe("email-worker");
  });

  test("should handle Mailgun webhook payload", async () => {
    const TEST_KEY = "test-mailgun-key";
    const timestamp = "1234567890";
    const token = "abc123";
    const signature = await generateMailgunSignature(
      timestamp,
      token,
      TEST_KEY
    );

    // Use FormData for proper multipart parsing compatibility
    const formData = new FormData();
    formData.append("subject", "Trade");
    formData.append(
      "body-plain",
      '{"exchange":"mexc","action":"buy","symbol":"BTC_USDT"}'
    );

    const req = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "User-Agent": "Mailgun",
        "Mailgun-Signature": signature,
        "Mailgun-Timestamp": timestamp,
        "Mailgun-Token": token,
      },
      body: formData,
    });

    const mockEnv = {
      INTERNAL_KEY_BINDING: "test-key",
      MAILGUN_API_KEY: TEST_KEY,
      CONFIG_KV: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
      TRADE_SERVICE: {
        fetch: vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ requestId: "123" }), { status: 200 })
          ),
      },
    } as any;

    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.requestId).toBe("123");
    expect(mockEnv.TRADE_SERVICE.fetch).toHaveBeenCalled();
  });

  test("should handle Mailgun webhook with invalid signal", async () => {
    const TEST_KEY = "test-mailgun-key";
    const timestamp = "1234567891";
    const token = "def456";
    const signature = await generateMailgunSignature(
      timestamp,
      token,
      TEST_KEY
    );

    const formData = new FormData();
    formData.append("subject", "Hello");
    formData.append("body-plain", "Just saying hi");

    const req = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "Mailgun-Signature": signature,
        "Mailgun-Timestamp": timestamp,
        "Mailgun-Token": token,
      },
      body: formData,
    });

    const mockEnv = {
      MAILGUN_API_KEY: TEST_KEY,
      CONFIG_KV: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
    const res = await worker.fetch(req, mockEnv, mockCtx);
    // "Just saying hi" doesn't contain a valid signal → bad request
    expect(res.status).toBe(400);
  });

  test("should handle direct JSON POST", async () => {
    const payload = {
      subject: "Test",
      body: '{"exchange":"binance","action":"buy","symbol":"ETH_USDT"}',
    };

    const req = new Request("http://localhost/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "test-key",
      },
      body: JSON.stringify(payload),
    });

    const mockEnv = {
      INTERNAL_KEY_BINDING: "test-key",
      CONFIG_KV: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
      TRADE_SERVICE: {
        fetch: vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ requestId: "456" }), { status: 200 })
          ),
      },
    } as any;

    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(200);
  });

  test("should handle TRADE_SERVICE error", async () => {
    const payload = {
      subject: "Test",
      body: '{"exchange":"binance","action":"buy","symbol":"ETH_USDT"}',
    };

    const req = new Request("http://localhost/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "test-key",
      },
      body: JSON.stringify(payload),
    });

    const mockEnv = {
      INTERNAL_KEY_BINDING: "test-key",
      CONFIG_KV: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
      TRADE_SERVICE: {
        fetch: vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        }),
      },
    } as any;

    const res = await worker.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(500);
  });
});
