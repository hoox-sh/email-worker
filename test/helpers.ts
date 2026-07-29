/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

// test/helpers.ts — Shared test utilities for email-worker tests

export async function generateMailgunSignature(
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

export const mockEnvBase = {
  CONFIG_KV: {
    get: async () => null,
    put: async () => {},
    list: async () => ({ keys: [] }),
    delete: async () => {},
    getWithMetadata: async () => ({ value: null, metadata: null }),
  },
  INTERNAL_KEY_BINDING: "internal-key-123",
  MAILGUN_API_KEY: "test-mailgun-api-key",
};
