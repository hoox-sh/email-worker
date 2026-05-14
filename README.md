# @hoox/email-worker

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare%C2%AE%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

Parses trading signals from email and routes them to execution.

## For CLI Users

Use this worker indirectly when you run `hoox` commands:

- `hoox secrets update-cf IMAP_HOST email-worker` — configure email server settings

→ [Email Signals Tutorial](../../docs/tutorials/email-signals.md) · [CLI Reference](../../docs/reference/cli-commands.md)

## For Operators

This worker provides email-to-signal conversion. It connects to IMAP servers (Gmail, Outlook, Yahoo) or accepts webhooks (SendGrid, Mailgun), parses email content for trading signals (symbol, action, quantity), and forwards validated payloads to the hoox gateway for execution.

→ [Operator Docs](../../docs/devops/workers/email-worker.md)

## Development

```bash
bun test workers/email-worker
```
