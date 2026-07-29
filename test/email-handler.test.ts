/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

// test/email-handler.test.ts — Tests for Cloudflare Email Routing handler

import { describe, expect, test, jest } from "bun:test";
import { emailHandler } from "../src/email-handler";
import { mockEnvBase } from "./helpers";

// Mock ForwardableEmailMessage
function createMockMessage(rawContent: string) {
  return {
    from: "sender@example.com",
    to: "trades@hoox.trade",
    headers: new Headers({ subject: "Test Signal" }),
    raw: new Blob([rawContent]).stream(),
    rawSize: rawContent.length,
    setReject: jest.fn(),
    forward: jest.fn(),
  } as any;
}

describe("Email Routing handler", () => {
  test("parses valid signal from email body and forwards to trade-worker", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ requestId: "er-123" }), { status: 200 })
      );

    const rawEmail =
      "From: sender@example.com\r\n" +
      "To: trades@hoox.trade\r\n" +
      "Subject: Test Signal\r\n" +
      'Content-Type: text/plain; charset="utf-8"\r\n' +
      "\r\n" +
      '{"exchange":"binance","action":"buy","symbol":"BTCUSDT","quantity":0.5}';

    const message = createMockMessage(rawEmail);
    const env = {
      ...mockEnvBase,
      TRADE_SERVICE: { fetch: mockFetch } as any,
    };
    const ctx = { waitUntil: jest.fn() } as any;

    await emailHandler(message, env, ctx);

    expect(mockFetch).toHaveBeenCalled();
  });

  test("handles email with no valid signal gracefully", async () => {
    const mockFetch = jest.fn();

    const rawEmail =
      "From: sender@example.com\r\n" +
      "To: trades@hoox.trade\r\n" +
      "Subject: Hello\r\n" +
      'Content-Type: text/plain; charset="utf-8"\r\n' +
      "\r\n" +
      "Just checking in";

    const message = createMockMessage(rawEmail);
    const env = {
      ...mockEnvBase,
      TRADE_SERVICE: { fetch: mockFetch } as any,
    };
    const ctx = { waitUntil: jest.fn() } as any;

    await emailHandler(message, env, ctx);

    // Should not throw, should not call fetch
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
