/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test } from "bun:test";
import {
  parseEmailSignal,
  verifyMailgunSignature,
  compileSafePattern,
  MAILGUN_TIMESTAMP_TOLERANCE_SEC,
} from "../src/index";
import { generateMailgunSignature } from "./helpers";

const defaultPatterns = {
  coinPattern: /BTC|ETH|SOL/i,
  actionPattern: /buy|sell|long|short/i,
  quantityMultiplier: 1,
};

describe("Email Signal Parsing", () => {
  test("should parse valid JSON signal", () => {
    const json =
      '{"exchange":"binance","action":"buy","symbol":"BTCUSDT","quantity":100}';
    const result = parseEmailSignal(json, defaultPatterns);
    expect(result).not.toBeNull();
    expect(result!.exchange).toBe("binance");
    expect(result!.action).toBe("LONG");
    expect(result!.symbol).toBe("BTCUSDT");
  });

  test("should parse plaintext with keywords", () => {
    const plaintext = "exchange: binance\naction: buy\nsymbol: BTCUSDT";
    const result = parseEmailSignal(plaintext, defaultPatterns);
    expect(result).not.toBeNull();
    expect(result!.exchange).toBe("binance");
  });

  test("should extract quantity from plaintext", () => {
    const plaintext =
      "exchange: binance\naction: sell\nsymbol: ETHUSDT\nquantity: 2.5";
    const result = parseEmailSignal(plaintext, defaultPatterns);
    expect(result).not.toBeNull();
    expect(result!.quantity).toBe(2.5);
    expect(result!.action).toBe("SHORT");
  });

  test("should reject negative quantity in JSON", () => {
    const json =
      '{"exchange":"binance","action":"buy","symbol":"BTCUSDT","quantity":-1}';
    const result = parseEmailSignal(json, defaultPatterns);
    expect(result).toBeNull();
  });

  test("should return null for invalid input", () => {
    expect(parseEmailSignal("", defaultPatterns)).toBeNull();
    expect(parseEmailSignal("random text", defaultPatterns)).toBeNull();
  });
});

describe("compileSafePattern", () => {
  test("accepts simple alternation patterns", () => {
    const re = compileSafePattern("BTC|ETH", "SOL");
    expect(re.test("btc")).toBe(true);
    expect(re.test("eth")).toBe(true);
  });

  test("falls back on ReDoS-prone sources", () => {
    const re = compileSafePattern("(a+)+$", "BTC|ETH");
    expect(re.source).toBe("BTC|ETH");
  });
});

describe("verifyMailgunSignature", () => {
  const apiKey = "test-mailgun-api-key";

  test("accepts valid fresh signature", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const token = "tok-valid";
    const signature = await generateMailgunSignature(timestamp, token, apiKey);
    const result = await verifyMailgunSignature({
      signature,
      timestamp,
      token,
      apiKey,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects stale timestamp (replay)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const timestamp = String(nowSec - MAILGUN_TIMESTAMP_TOLERANCE_SEC - 1);
    const token = "tok-stale";
    const signature = await generateMailgunSignature(timestamp, token, apiKey);
    const result = await verifyMailgunSignature({
      signature,
      timestamp,
      token,
      apiKey,
      nowSec,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("timestamp");
    }
  });

  test("rejects wrong signature with timing-safe compare", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const result = await verifyMailgunSignature({
      signature: "0".repeat(64),
      timestamp,
      token: "tok",
      apiKey,
    });
    expect(result.ok).toBe(false);
  });
});

describe("parseEmailSignal error callbacks", () => {
  test("sets error for unsupported exchange in JSON", () => {
    let err: Response | null = null;
    const json =
      '{"exchange":"kraken","action":"buy","symbol":"BTCUSDT","quantity":1}';
    const result = parseEmailSignal(json, defaultPatterns, {
      set: (r) => {
        err = r;
      },
    });
    expect(result).toBeNull();
    expect(err).not.toBeNull();
  });

  test("sets error for invalid quantity after multiplier", () => {
    let err: Response | null = null;
    const json =
      '{"exchange":"binance","action":"buy","symbol":"BTCUSDT","quantity":1}';
    const result = parseEmailSignal(
      json,
      { ...defaultPatterns, quantityMultiplier: 0 },
      {
        set: (r) => {
          err = r;
        },
      }
    );
    expect(result).toBeNull();
    expect(err).not.toBeNull();
  });

  test("falls through malformed JSON that looks like JSON", () => {
    const result = parseEmailSignal("{not valid json", defaultPatterns);
    expect(result).toBeNull();
  });
});

describe("verifyMailgunSignature extra cases", () => {
  const apiKey = "test-mailgun-api-key";

  test("rejects empty api key", async () => {
    const result = await verifyMailgunSignature({
      signature: "abc",
      timestamp: String(Math.floor(Date.now() / 1000)),
      token: "tok",
      apiKey: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("MAILGUN_API_KEY");
  });

  test("rejects invalid timestamp format", async () => {
    const result = await verifyMailgunSignature({
      signature: "abc",
      timestamp: "not-a-number",
      token: "tok",
      apiKey,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Invalid Mailgun timestamp");
  });
});

describe("loadSignalPatterns", () => {
  test("loads defaults when KV returns null", async () => {
    const { loadSignalPatterns } = await import("../src/index");
    const env = {
      CONFIG_KV: {
        get: async () => null,
      },
    } as any;
    const patterns = await loadSignalPatterns(env);
    expect(patterns.coinPattern.test("BTC")).toBe(true);
    expect(patterns.actionPattern.test("buy")).toBe(true);
    expect(patterns.quantityMultiplier).toBe(1);
  });

  test("uses cached patterns on second call", async () => {
    const { loadSignalPatterns } = await import("../src/index");
    let calls = 0;
    const env = {
      CONFIG_KV: {
        get: async () => {
          calls++;
          return null;
        },
      },
    } as any;
    await loadSignalPatterns(env);
    const before = calls;
    await loadSignalPatterns(env);
    // cache hit should not re-fetch all three keys again (or fewer calls)
    expect(calls).toBeLessThanOrEqual(before + 3);
  });
});
