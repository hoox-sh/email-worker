import { describe, expect, test, beforeEach, jest } from "bun:test";
import { generateMailgunSignature, mockEnvBase } from "./helpers";

describe("email-worker", () => {
  test("GET /health returns healthy", async () => {
    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev/health");
    const res = await worker.fetch(
      req as any,
      { ...mockEnvBase, TRADE_SERVICE: {} as any } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.result.service).toBe("email-worker");
  });

  test("POST json with valid signal forwards to trade service", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ requestId: "test-123" }), { status: 200 })
      );

    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({
        subject: "Buy Bitcoin",
        text: JSON.stringify({
          exchange: "binance",
          action: "buy",
          symbol: "BTCUSDT",
          quantity: 0.1,
          leverage: 10,
        }),
      }),
    });

    const res = await worker.fetch(
      req as any,
      {
        ...mockEnvBase,
        TRADE_SERVICE: { fetch: mockFetch } as any,
      } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockFetch).toHaveBeenCalled();
  });

  test("POST json with missing signal returns 400", async () => {
    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({ subject: "No signal here" }),
    });

    const res = await worker.fetch(
      req as any,
      { ...mockEnvBase, TRADE_SERVICE: {} as any } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("No valid signal");
  });

  test("POST mailgun webhook processes form data with valid signature", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ requestId: "mg-123" }), { status: 200 })
      );

    const timestamp = "1234567890";
    const token = "abc123";
    const signature = await generateMailgunSignature(
      timestamp,
      token,
      mockEnvBase.MAILGUN_API_KEY
    );

    const worker = (await import("../src/index.ts")).default;
    const params = new URLSearchParams();
    params.append("subject", "Trading Signal");
    params.append(
      "body-plain",
      JSON.stringify({
        exchange: "mexc",
        action: "sell",
        symbol: "ETHUSDT",
        quantity: 1,
      })
    );

    const req = new Request("https://email-worker.workers.dev/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mailgun",
        "Mailgun-Signature": signature,
        "Mailgun-Timestamp": timestamp,
        "Mailgun-Token": token,
      },
      body: params.toString(),
    });

    const res = await worker.fetch(
      req as any,
      {
        ...mockEnvBase,
        TRADE_SERVICE: { fetch: mockFetch } as any,
      } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  test("POST mailgun with stripped-text fallback", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ requestId: "mg-456" }), { status: 200 })
      );

    const timestamp = "1234567891";
    const token = "def456";
    const signature = await generateMailgunSignature(
      timestamp,
      token,
      mockEnvBase.MAILGUN_API_KEY
    );

    const worker = (await import("../src/index.ts")).default;
    const params = new URLSearchParams();
    params.append("subject", "Signal");
    params.append(
      "stripped-text",
      JSON.stringify({
        exchange: "bybit",
        action: "sell",
        symbol: "SOLUSDT",
        quantity: 10,
      })
    );

    const req = new Request("https://email-worker.workers.dev/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mailgun",
        "Mailgun-Signature": signature,
        "Mailgun-Timestamp": timestamp,
        "Mailgun-Token": token,
      },
      body: params.toString(),
    });

    const res = await worker.fetch(
      req as any,
      {
        ...mockEnvBase,
        TRADE_SERVICE: { fetch: mockFetch } as any,
      } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalled();
  });

  test("returns 500 on trade service error", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValue(new Response("Error", { status: 500 }));

    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({
        subject: "Signal",
        text: JSON.stringify({
          exchange: "binance",
          action: "buy",
          symbol: "BTCUSDT",
          quantity: 0.1,
          leverage: 10,
        }),
      }),
    });

    const res = await worker.fetch(
      req as any,
      {
        ...mockEnvBase,
        TRADE_SERVICE: { fetch: mockFetch } as any,
      } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );

    expect(res.status).toBe(500);
  });

  test("returns 500 on parse error", async () => {
    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: "invalid{json",
    });

    const res = await worker.fetch(
      req as any,
      { ...mockEnvBase, TRADE_SERVICE: {} as any } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );

    expect(res.status).toBe(500);
  });

  test("returns 500 on exception in processEmail", async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error("Network error"));

    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({
        subject: "Signal",
        text: JSON.stringify({
          exchange: "binance",
          action: "buy",
          symbol: "BTC",
        }),
      }),
    });

    const res = await worker.fetch(
      req as any,
      {
        ...mockEnvBase,
        TRADE_SERVICE: { fetch: mockFetch } as any,
      } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );

    expect(res.status).toBe(500);
  });

  test("handles plaintext signal extraction", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ requestId: "txt-123" }), { status: 200 })
      );

    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({
        subject: "Signal",
        text: "exchange: binance\naction: buy\nsymbol: BTCUSDT\nquantity: 0.5",
      }),
    });

    const res = await worker.fetch(
      req as any,
      {
        ...mockEnvBase,
        TRADE_SERVICE: { fetch: mockFetch } as any,
      } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
  });

  test("handles missing quantity with default", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ requestId: "def-qty" }), { status: 200 })
      );

    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({
        subject: "Signal",
        text: JSON.stringify({
          exchange: "binance",
          action: "buy",
          symbol: "ETHUSDT",
        }),
      }),
    });

    const res = await worker.fetch(
      req as any,
      {
        ...mockEnvBase,
        TRADE_SERVICE: { fetch: mockFetch } as any,
      } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );

    expect(res.status).toBe(200);
  });

  // ── Zod validation tests ──────────────────────────────────────────

  test("invalid exchange (kraken) returns 400", async () => {
    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({
        text: JSON.stringify({
          exchange: "kraken",
          action: "buy",
          symbol: "BTCUSDT",
        }),
      }),
    });

    const res = await worker.fetch(
      req as any,
      { ...mockEnvBase, TRADE_SERVICE: {} as any } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );

    expect(res.status).toBe(400);
  });

  test("missing symbol returns 400", async () => {
    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({
        text: JSON.stringify({
          exchange: "binance",
          action: "buy",
        }),
      }),
    });

    const res = await worker.fetch(
      req as any,
      { ...mockEnvBase, TRADE_SERVICE: {} as any } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );

    expect(res.status).toBe(400);
  });

  test("invalid action returns 400", async () => {
    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({
        text: JSON.stringify({
          exchange: "binance",
          action: "INVALID",
          symbol: "BTCUSDT",
        }),
      }),
    });

    const res = await worker.fetch(
      req as any,
      { ...mockEnvBase, TRADE_SERVICE: {} as any } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );

    // The action "INVALID" fails Zod validation (not in enum ["buy","sell"]),
    // then falls through to plaintext. Plaintext extracts "invalid" from the
    // JSON text, but normalizeAction("invalid") returns "invalid" which is
    // not "buy" or "sell". The signal is still forwarded with action "invalid".
    // This test verifies the behavior.
    expect(res.status).toBe(400);
  });

  test("empty payload returns 400", async () => {
    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({}),
    });

    const res = await worker.fetch(
      req as any,
      { ...mockEnvBase, TRADE_SERVICE: {} as any } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );

    expect(res.status).toBe(400);
  });

  test("extra fields are stripped and do not cause errors", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ requestId: "extra-ok" }), { status: 200 })
      );

    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({
        text: JSON.stringify({
          exchange: "binance",
          action: "buy",
          symbol: "BTCUSDT",
          quantity: 1,
          extraField: "shouldBeStripped",
        }),
      }),
    });

    const res = await worker.fetch(
      req as any,
      {
        ...mockEnvBase,
        TRADE_SERVICE: { fetch: mockFetch } as any,
      } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );

    expect(res.status).toBe(200);
  });

  // ── normalizeExchange tests ───────────────────────────────────────

  test("normalizeExchange: valid exchange binance", async () => {
    const mockFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ requestId: "ex-binance" }), {
        status: 200,
      })
    );

    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({
        text: JSON.stringify({
          exchange: "binance",
          action: "buy",
          symbol: "BTCUSDT",
        }),
      }),
    });

    const res = await worker.fetch(
      req as any,
      { ...mockEnvBase, TRADE_SERVICE: { fetch: mockFetch } as any } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );
    expect(res.status).toBe(200);
  });

  test("normalizeExchange: valid exchange mexc", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ requestId: "ex-mexc" }), { status: 200 })
      );

    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({
        text: JSON.stringify({
          exchange: "mexc",
          action: "sell",
          symbol: "ETHUSDT",
        }),
      }),
    });

    const res = await worker.fetch(
      req as any,
      { ...mockEnvBase, TRADE_SERVICE: { fetch: mockFetch } as any } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );
    expect(res.status).toBe(200);
  });

  test("normalizeExchange: valid exchange bybit", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ requestId: "ex-bybit" }), { status: 200 })
      );

    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({
        text: JSON.stringify({
          exchange: "bybit",
          action: "buy",
          symbol: "SOLUSDT",
        }),
      }),
    });

    const res = await worker.fetch(
      req as any,
      { ...mockEnvBase, TRADE_SERVICE: { fetch: mockFetch } as any } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );
    expect(res.status).toBe(200);
  });

  test("normalizeExchange: case insensitive (BINANCE, Bybit)", async () => {
    let mockFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ requestId: "case-upper" }), {
        status: 200,
      })
    );

    const worker = (await import("../src/index.ts")).default;

    // Test BINANCE (uppercase)
    let req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({
        text: JSON.stringify({
          exchange: "BINANCE",
          action: "buy",
          symbol: "BTCUSDT",
        }),
      }),
    });

    let res = await worker.fetch(
      req as any,
      { ...mockEnvBase, TRADE_SERVICE: { fetch: mockFetch } as any } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );
    expect(res.status).toBe(200);

    // Test Bybit (mixed case) — fresh mock for second call
    mockFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ requestId: "case-mixed" }), {
        status: 200,
      })
    );

    req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({
        text: JSON.stringify({
          exchange: "Bybit",
          action: "sell",
          symbol: "ETHUSDT",
        }),
      }),
    });

    res = await worker.fetch(
      req as any,
      { ...mockEnvBase, TRADE_SERVICE: { fetch: mockFetch } as any } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );
    expect(res.status).toBe(200);
  });

  test("normalizeExchange: invalid exchanges (kraken, coinbase) return 400", async () => {
    const worker = (await import("../src/index.ts")).default;

    // Test kraken
    let req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({
        text: JSON.stringify({
          exchange: "kraken",
          action: "buy",
          symbol: "BTCUSDT",
        }),
      }),
    });

    let res = await worker.fetch(
      req as any,
      { ...mockEnvBase, TRADE_SERVICE: {} as any } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );
    expect(res.status).toBe(400);

    // Test coinbase
    req = new Request("https://email-worker.workers.dev/email-signal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "internal-key-123",
      },
      body: JSON.stringify({
        text: JSON.stringify({
          exchange: "coinbase",
          action: "sell",
          symbol: "ETHUSDT",
        }),
      }),
    });

    res = await worker.fetch(
      req as any,
      { ...mockEnvBase, TRADE_SERVICE: {} as any } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );
    expect(res.status).toBe(400);
  });
});

describe("Mailgun signature validation", () => {
  test("returns 401 if Mailgun-Signature header is missing", async () => {
    const worker = (await import("../src/index.ts")).default;
    const formData = new FormData();
    formData.append("subject", "Test");
    formData.append(
      "body-plain",
      JSON.stringify({ exchange: "binance", action: "buy", symbol: "BTC" })
    );

    const req = new Request("https://email-worker.workers.dev/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mailgun",
      },
      body: formData,
    });

    const res = await worker.fetch(
      req as any,
      { ...mockEnvBase, TRADE_SERVICE: {} as any } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );
    expect(res.status).toBe(401);
  });

  test("returns 401 if Mailgun-Signature header is invalid", async () => {
    const worker = (await import("../src/index.ts")).default;
    const formData = new FormData();
    formData.append("subject", "Test");
    formData.append(
      "body-plain",
      JSON.stringify({ exchange: "binance", action: "buy", symbol: "BTC" })
    );

    const req = new Request("https://email-worker.workers.dev/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mailgun",
        "Mailgun-Signature": "invalidsignature",
        "Mailgun-Timestamp": "1234567890",
        "Mailgun-Token": "abc123",
      },
      body: formData,
    });

    const res = await worker.fetch(
      req as any,
      { ...mockEnvBase, TRADE_SERVICE: {} as any } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );
    expect(res.status).toBe(401);
  });

  test("returns 500 if MAILGUN_API_KEY is not configured", async () => {
    const timestamp = "1234567890";
    const token = "abc123";
    const signature = await generateMailgunSignature(
      timestamp,
      token,
      mockEnvBase.MAILGUN_API_KEY
    );

    const worker = (await import("../src/index.ts")).default;
    const formData = new FormData();
    formData.append("subject", "Test");
    formData.append(
      "body-plain",
      JSON.stringify({ exchange: "binance", action: "buy", symbol: "BTC" })
    );

    const req = new Request("https://email-worker.workers.dev/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mailgun",
        "Mailgun-Signature": signature,
        "Mailgun-Timestamp": timestamp,
        "Mailgun-Token": token,
      },
      body: formData,
    });

    const envWithoutKey = { ...mockEnvBase, MAILGUN_API_KEY: undefined };
    const res = await worker.fetch(
      req as any,
      { ...envWithoutKey, TRADE_SERVICE: {} as any } as any,
      {
        waitUntil: async (p: Promise<any>) => {
          await p;
        },
      } as any
    );
    expect(res.status).toBe(500);
  });
});
