# HOOX · Email Worker

**Signal ingestion from the inbox — parses natural-language trade instructions from email and converts them into structured execution payloads.**

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare%C2%AE%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

**Part of the [HOOX](https://github.com/hoox-sh/hoox) edge-trading mesh — a production-grade algorithmic trading framework on Cloudflare Workers.**  
**Site:** [hoox.sh](https://hoox.sh) · **Docs:** [docs.hoox.sh](https://docs.hoox.sh) · **Paper:** [`hoox-arxiv-paper-core.pdf`](https://github.com/hoox-sh/hoox/blob/main/papers/hoox-arxiv-paper-core.pdf)

---

The email-worker converts unstructured textual signals into structured trade payloads. It supports two ingress paths: a **Mailgun webhook** (`POST /webhook`) with HMAC-SHA256 signature verification (`Mailgun-Signature`, `Mailgun-Timestamp`, `Mailgun-Token` validated via `crypto.subtle` against `MAILGUN_API_KEY`), and a **direct JSON POST** (`POST /email-signal`) for internal consumers.

Both paths feed into `parseEmailSignal`, which attempts JSON deserialization first and falls back to regex-based extraction using configurable patterns from `CONFIG_KV` (`coinPattern`, `actionPattern`, `quantityMultiplier`). Extracted fields — exchange (normalized to `binance`/`mexc`/`bybit`), action (`LONG`/`SHORT`), symbol (uppercase, stripped), quantity, optional price, leverage, and `test` — are validated and forwarded to the [`trade-worker`](../trade-worker) via the `TRADE_SERVICE` service binding with `X-Source: email-worker` origin tagging. JSON bodies may include `"test": true` to request exchange testnet execution when the target exchange supports it.

### Role in the Mesh

```
Mailgun Webhook ──┐
Direct JSON POST ─┼──► email-worker ──► trade-worker (execution)
                   │        │
                   │        └──► analytics-worker (telemetry)
                   │
              CONFIG_KV (signal patterns)
```

### Entry Points

| Method | Path            | Auth         | Description                        |
| ------ | --------------- | ------------ | ---------------------------------- |
| `POST` | `/webhook`      | HMAC-SHA256  | Mailgun webhook receiver (primary) |
| `POST` | `/email-signal` | Internal key | Direct JSON signal submission      |
| `GET`  | `/health`       | None         | Liveness probe                     |

### Signal Parsing Pipeline

```
Raw Input (email body / JSON)
    │
    ▼
JSON.parse attempt ──success──► structured EmailSignal
    │ fail
    ▼
Regex extraction ──match──► { exchange, action, symbol, quantity }
    │ (patterns from CONFIG_KV)    │
    │                              ▼
    │                    Normalization layer
    │                    (exchange aliases, action casing,
    │                     symbol stripping, qty * multiplier)
    │                              │
    │                              ▼
    └──► Error / Invalid signal → analytics log
```

### Development

```bash
bun test workers/email-worker
```

### License

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — part of the HOOX open-core mesh.
