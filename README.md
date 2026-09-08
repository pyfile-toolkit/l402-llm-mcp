# l402-llm-mcp

Pay-per-query LLM access over Lightning (L402), exposed as an MCP server.

## What it is

A single Node.js server that serves two things:

- **MCP endpoint** `POST /mcp` (streamable HTTP, tool: `chat`)
- **OpenAI-compatible** `POST /v1/chat/completions`

Payment is enforced by the L402 protocol: every request returns a Lightning invoice
(10 sats short, 50 sats long). Models are proxied to a free LLM backend
(`gemini-3.6-flash`, `gpt-oss-120b`).

## Endpoints

| Path | Method | Price | Description |
|---|---|---|---|
| `/mcp` | POST | 10 sats | MCP streamable-HTTP, tool `chat` |
| `/v1/chat/completions` | POST | 10-50 sats | OpenAI-compatible chat |
| `/v1/models` | GET | free | model list |
| `/.well-known/l402.json` | GET | free | L402 manifest |

## Run

```bash
export LNBOT_API_KEY=... WALLET_ID=...
node server.js
```

## Discovery

Listed in the 402 Index and 402.pub (Nostr kind 31402).
