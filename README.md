# Email Worker

**Last Updated:** May 2026

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare®%20Edge%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/) [![Build Status](https://github.com/jango-blockchained/hoox-setup/actions/workflows/opencode.yml/badge.svg)](https://github.com/jango-blockchained/hoox-setup/actions/workflows/opencode.yml)

**[Main Repository](https://github.com/jango-blockchained/hoox-setup)** · **[View on GitHub](https://github.com/jango-blockchained/email-worker)**

A Cloudflare® Worker service that scans emails (via IMAP or webhooks) and triggers trading signals based on email content. This worker enables trading via email notifications from exchanges or custom alerts.

---

## About

This worker is part of the **[Hoox Trading System](https://github.com/jango-blockchained/hoox-setup)** - a zero-latency edge trading ecosystem. The `email-worker` handles:

- **Email Parsing**: Extracts trading signals from exchange emails and notifications
- **IMAP Integration**: Connects to email servers to fetch new messages
- **Webhook Support**: Accepts email webhooks from providers like SendGrid or Mailgun
- **Signal Extraction**: Parses email content to identify trading opportunities
- **Secure Authentication**: Validates requests from other workers via shared internal keys

---

## Features

- Scans emails for trading signals from supported exchanges
- Supports both IMAP polling and webhook ingestion
- Extracts key data: symbol, action, quantity, price
- Forwards validated signals to the `hoox` gateway for execution
- Configurable filtering to ignore non-trading emails

---

## Prerequisites

- Node.js >= 16
- Bun
- Wrangler CLI
- Cloudflare® Workers account
- Email account with IMAP access (or webhook provider)

---

## Setup

1. **Install dependencies:**
   ```bash
   bun install
   ```

2. **Set your Cloudflare® account ID in `wrangler.jsonc`.**

3. **Configure Secrets (via Cloudflare® dashboard or `wrangler secret put`):**
   - `INTERNAL_KEY_BINDING`: Shared secret key for authentication with other workers
   - `IMAP_USER`: Your email address
   - `IMAP_PASSWORD`: Your email password or app-specific password
   - `IMAP_HOST`: IMAP server hostname (e.g., `imap.gmail.com`)
   - `IMAP_PORT`: IMAP server port (usually 993 for SSL)

4. **Update `wrangler.jsonc` with necessary bindings:**
   ```jsonc
   {
     "name": "email-worker",
     "main": "src/index.ts",
     "compatibility_date": "2025-03-07",
     "compatibility_flags": ["nodejs_compat"],
     "account_id": "YOUR_CLOUDFLARE_ACCOUNT_ID",
     "secrets": [
       "INTERNAL_KEY_BINDING",
       "IMAP_USER",
       "IMAP_PASSWORD",
       "IMAP_HOST",
       "IMAP_PORT"
     ]
   }
   ```

5. **For local development, create a `.dev.vars` file:**
   ```.dev.vars
   INTERNAL_KEY_BINDING="your_shared_internal_secret"
   IMAP_USER="your_email@example.com"
   IMAP_PASSWORD="your_password"
   IMAP_HOST="imap.example.com"
   IMAP_PORT="993"
   ```

---

## Development

Run locally:
```bash
bun run dev
```

Deploy:
```bash
bun run deploy
```

---

## API Interface

### Incoming Request (Email Webhook -> email-worker)

- **Method:** `POST`
- **Endpoint:** `/webhook/email`
- **Content-Type:** `application/json`

**Payload Structure:**
```json
{
  "from": "exchange@example.com",
  "subject": "Trade Alert: BTCUSDT",
  "body": "Symbol: BTCUSDT\nAction: BUY\nQuantity: 0.1"
}
```

### Internal Request (email-worker -> hoox gateway)

Forwards parsed signals to the `hoox` gateway for execution:
```json
{
  "target": "trade",
  "symbol": "BTCUSDT",
  "action": "BUY",
  "quantity": 0.1,
  "apiKey": "internal_key_here"
}
```

---

## Configuration

### Supported Email Providers

| Provider | IMAP Host | Port | Notes |
|-----------|------------|------|-------|
| Gmail | `imap.gmail.com` | 993 | Requires app password |
| Outlook | `outlook.office365.com` | 993 | Modern auth required |
| Yahoo | `imap.mail.yahoo.com` | 993 | App password recommended |

### Signal Parsing Rules

The worker looks for these patterns in email content:
- **Symbol**: `BTCUSDT`, `ETHUSD`, etc.
- **Action**: `BUY`, `SELL`, `LONG`, `SHORT`
- **Quantity**: Numeric value
- **Price**: Optional price level

---

## Security Considerations

- **Credentials**: Store email passwords as Cloudflare Secrets, never in code
- **Internal Key**: Use strong, random internal key for worker-to-worker auth
- **Webhook Secret**: If using webhooks, validate the signature
- **Rate Limiting**: Consider adding KV-based rate limiting for webhook endpoints

---

*Cloudflare® and the Cloudflare logo are trademarks and/or registered trademarks of Cloudflare, Inc. in the United States and other jurisdictions.*
