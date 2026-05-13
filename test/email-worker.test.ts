import { describe, expect, test, beforeEach, jest } from "bun:test";

const TEST_MAILGUN_API_KEY = "test-mailgun-api-key";

async function generateMailgunSignature(
  timestamp: string,
  token: string,
  apiKey: string
): Promise<string> {
  const encoder = new TextEncoder();
  const dataToSign = timestamp + token;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(dataToSign)
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const mockEnvBase = {
  CONFIG_KV: {
    get: async () => null,
    put: async () => {},
    list: async () => ({ keys: [] }),
    delete: async () => {},
    getWithMetadata: async () => ({ value: null, metadata: null }),
  },
  EMAIL_HOST_BINDING: "imap.example.com",
  EMAIL_USER_BINDING: "user@example.com",
  EMAIL_PASS_BINDING: "password123",
  INTERNAL_KEY_BINDING: "internal-key-123",
  MAILGUN_API_KEY: TEST_MAILGUN_API_KEY,
  EMAIL_SCAN_SUBJECT: "Trading Signal",
  USE_IMAP: "false",
};

describe("email-worker", () => {
  test("GET returns ready message", async () => {
    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev");
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
    expect(await res.text()).toContain("Email Worker Ready");
  });

  test("POST json with valid signal forwards to trade service", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ requestId: "test-123" }), { status: 200 })
      );

    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    const req = new Request("https://email-worker.workers.dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      TEST_MAILGUN_API_KEY
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

    const req = new Request("https://email-worker.workers.dev", {
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
      TEST_MAILGUN_API_KEY
    );

    const worker = (await import("../src/index.ts")).default;
    const params = new URLSearchParams();
    params.append("subject", "Signal");
    params.append(
      "stripped-text",
      JSON.stringify({
        exchange: "bybit",
        action: "long",
        symbol: "SOLUSDT",
        quantity: 10,
      })
    );

    const req = new Request("https://email-worker.workers.dev", {
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
    const req = new Request("https://email-worker.workers.dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

  test("returns 500 on parse error", async () => {
    const worker = (await import("../src/index.ts")).default;
    const req = new Request("https://email-worker.workers.dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    const req = new Request("https://email-worker.workers.dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    const req = new Request("https://email-worker.workers.dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    const req = new Request("https://email-worker.workers.dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

    const req = new Request("https://email-worker.workers.dev", {
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

    const req = new Request("https://email-worker.workers.dev", {
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
      TEST_MAILGUN_API_KEY
    );

    const worker = (await import("../src/index.ts")).default;
    const formData = new FormData();
    formData.append("subject", "Test");
    formData.append(
      "body-plain",
      JSON.stringify({ exchange: "binance", action: "buy", symbol: "BTC" })
    );

    const req = new Request("https://email-worker.workers.dev", {
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

describe("scheduled handler", () => {
  test("skips IMAP when USE_IMAP is not true", async () => {
    const worker = (await import("../src/index.ts")).default;

    const mockEnv = {
      ...mockEnvBase,
      USE_IMAP: "false",
    };

    await expect(worker.scheduled(mockEnv as any)).resolves.toBeUndefined();
  });

  test("returns 501 when IMAP credentials missing", async () => {
    const worker = (await import("../src/index.ts")).default;

    const mockEnv = {
      USE_IMAP: "true",
      EMAIL_HOST_BINDING: { get: async () => null },
      EMAIL_USER_BINDING: undefined,
      EMAIL_PASS_BINDING: { get: async () => null },
      EMAIL_SCAN_SUBJECT: "Signal",
    };

    await expect(worker.scheduled(mockEnv as any)).resolves.toBeUndefined();
  });
});
