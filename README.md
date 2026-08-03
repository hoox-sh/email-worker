# HOOX · Email Worker

**Signal ingestion from the inbox — parses natural-language trade instructions from email and converts them into structured execution payloads.**

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare%C2%AE%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

**Part of the [HOOX](https://github.com/hoox-sh/hoox) edge-trading mesh — a production-grade algorithmic trading framework on Cloudflare Workers.**  
**Site:** [hoox.sh](https://hoox.sh) · **Docs:** [docs.hoox.sh](https://docs.hoox.sh) · **Paper:** [`hoox-arxiv-paper-core.pdf`](https://github.com/hoox-sh/hoox/blob/main/papers/hoox-arxiv-paper-core.pdf)

---

The email-worker converts unstructured textual signals into structured trade payloads. It supports two ingress paths: a **Mailgun webhook** (`POST /webhook`) with HMAC-SHA256 signature verification (`Mailgun-Signature`, `Mailgun-Timestamp`, `Mailgun-Token` validated via `crypto.subtle` against `MAILGUN_API_KEY`), and a **direct JSON POST** (`POST /email-signal`) for internal consumers.

Both paths feed into `parseEmailSignal`, which attempts JSON deserialization first and falls back to regex-based extraction using configurable patterns from `CONFIG_KV` (`coinPattern`, `actionPattern`, `quantityMultiplier`). Extracted fields — exchange (normalized to `binance`/`mexc`/`bybit`), action (`LONG`/`SHORT`), symbol (uppercase, stripped), quantity, optional price, leverage, and `test` — are validated and forwarded to the [`trade-worker`](https://github.com/hoox-sh/trade-worker) via the `TRADE_SERVICE` service binding with `X-Source: email-worker` origin tagging. JSON bodies may include `"test": true` to request exchange testnet execution when the target exchange supports it.

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

### Mesh interconnect

| Direction | Peers |
| --------- | ----- |
| **Called by** | Mailgun webhooks and internal JSON clients (`POST /email-signal`). |
| **This worker calls** | See list below |

- **[trade-worker](https://github.com/hoox-sh/trade-worker)** — TRADE_SERVICE — structured trade payloads
- **[analytics-worker](https://github.com/hoox-sh/analytics-worker)** — ANALYTICS_SERVICE — parse / forward telemetry

Full mesh (all isolates live as git submodules under [`hoox-sh/hoox`](https://github.com/hoox-sh/hoox) `workers/`):

| Isolate | Role | Repository |
| ------- | ---- | ---------- |
| [hoox-worker](https://github.com/hoox-sh/hoox-worker) | Public webhook gateway (WAF, idempotency, dispatch) | monorepo `workers/hoox-worker` |
| [trade-worker](https://github.com/hoox-sh/trade-worker) | Multi-exchange order execution (Binance / Bybit / MEXC) | monorepo `workers/trade-worker` |
| [agent-worker](https://github.com/hoox-sh/agent-worker) | AI risk manager (5-min cron, kill switch) | monorepo `workers/agent-worker` |
| [d1-worker](https://github.com/hoox-sh/d1-worker) | D1 SQL proxy + settings / balances / positions | monorepo `workers/d1-worker` |
| [telegram-worker](https://github.com/hoox-sh/telegram-worker) | Alerts, bot commands, RAG copilot | monorepo `workers/telegram-worker` |
| [email-worker](https://github.com/hoox-sh/email-worker) | Mailgun / email signal parsing → trade | monorepo `workers/email-worker` |
| [analytics-worker](https://github.com/hoox-sh/analytics-worker) | Analytics Engine write + query path | monorepo `workers/analytics-worker` |
| [report-worker](https://github.com/hoox-sh/report-worker) | PDF reports via Browser Rendering → R2 | monorepo `workers/report-worker` |
| [web3-wallet-worker](https://github.com/hoox-sh/web3-wallet-worker) | On-chain wallet identity (ethers.js) | monorepo `workers/web3-wallet-worker` |
| [dashboard](https://github.com/hoox-sh/hoox/tree/main/workers/dashboard) | Next.js ops console (OpenNext, public) | monorepo `workers/dashboard` |

### Docs & monorepo

| Resource | Link |
| -------- | ---- |
| Isolate profile (operators) | [https://docs.hoox.sh/docs/devops/workers/email-worker](https://docs.hoox.sh/docs/devops/workers/email-worker) |
| Parent monorepo | [github.com/hoox-sh/hoox](https://github.com/hoox-sh/hoox) |
| This repository | [github.com/hoox-sh/email-worker](https://github.com/hoox-sh/email-worker) |
| Workers index | [docs.hoox.sh → Workers](https://docs.hoox.sh/docs/devops/workers) |
| CLI | `@hoox-sh/hoox-cli` · `hoox deploy worker email-worker` |

### License

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — part of the HOOX open-core mesh.
