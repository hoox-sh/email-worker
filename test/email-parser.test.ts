import { describe, expect, test } from "bun:test";
import { parseEmailSignal } from "../src/index";

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
    expect(result!.action).toBe("buy");
    expect(result!.symbol).toBe("BTCUSDT");
  });

  test("should parse plaintext with keywords", () => {
    const plaintext = "exchange: binance\naction: buy\nsymbol: BTCUSDT";
    const result = parseEmailSignal(plaintext, defaultPatterns);
    expect(result).not.toBeNull();
    expect(result!.exchange).toBe("binance");
  });

  test("should return null for invalid input", () => {
    expect(parseEmailSignal("", defaultPatterns)).toBeNull();
    expect(parseEmailSignal("random text", defaultPatterns)).toBeNull();
  });
});
