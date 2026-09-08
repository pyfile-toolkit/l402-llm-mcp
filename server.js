// L402 LLM API — платный доступ к бесплатным LLM за саты (Lightning).
// Запросы проксируются на frellmapi (localhost:3001), оплата через ln.bot.
const express = require('express');
const { l402, LnBot } = require('@lnbot/l402');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));

// Настройки из vault/lnbot.json
const VAULT_DIR = path.join(__dirname, '..', 'vault');
const lnbotCfg = JSON.parse(fs.readFileSync(path.join(VAULT_DIR, 'lnbot.json'), 'utf8'));
const LNBOT_API_KEY = process.env.LNBOT_API_KEY || lnbotCfg.api_key;
const WALLET_ID = process.env.WALLET_ID || lnbotCfg.wallet_id;
const FRELLMAPI = process.env.FRELLMAPI_URL || 'http://localhost:3001';
const FRELLMAPI_KEY = process.env.FRELLMAPI_KEY || (fs.existsSync(path.join(VAULT_DIR, 'frellmapi_key.txt')) ? fs.readFileSync(path.join(VAULT_DIR, 'frellmapi_key.txt'), 'utf8').trim() : '');

const ln = new LnBot({ apiKey: LNBOT_API_KEY });

const PRICE_CHAT = Number(process.env.PRICE_CHAT || 10);   // обычный запрос
const PRICE_LONG = Number(process.env.PRICE_LONG || 50);   // длинный (>8k байт)

function priceFor(req) {
  const body = req.body || {};
  const size = JSON.stringify(body).length;
  return size > 8000 ? PRICE_LONG : PRICE_CHAT;
}

// Проксирование на frellmapi /v1/chat/completions
function proxyToFrellmapi(req, res) {
  const payload = JSON.stringify(req.body || {});
  const url = new URL(FRELLMAPI + '/v1/chat/completions');
  const transport = url.protocol === 'https:' ? https : http;

  const upstream = transport.request({
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(FRELLMAPI_KEY ? { 'Authorization': 'Bearer ' + FRELLMAPI_KEY } : {}),
      'Content-Length': Buffer.byteLength(payload),
    },
  }, (upRes) => {
    let data = '';
    upRes.on('data', (c) => data += c);
    upRes.on('end', () => {
      res.status(upRes.statusCode).set('Content-Type', upRes.headers['content-type'] || 'application/json');
      res.end(data);
    });
  });
  upstream.on('error', (e) => {
    res.status(502).json({ error: { message: 'upstream error: ' + e.message, type: 'upstream_error' } });
  });
  upstream.write(payload);
  upstream.end();
}

// Paywall: каждый POST /v1/chat/completions стоит саты
app.post('/v1/chat/completions', l402.paywall(ln, {
  walletId: WALLET_ID,
  price: priceFor,
  description: 'LLM API access (chat completions) — pay per request',
  expirySeconds: 300,
}), proxyToFrellmapi);

// Каталог моделей бесплатно
app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'gemini-3.6-flash', object: 'model' },
      { id: 'gpt-oss-120b', object: 'model' },
    ],
  });
});

// L402 manifest для discoverability (бесплатно)
app.get('/.well-known/l402.json', (_req, res) => {
  res.json({
    name: 'L402 LLM API',
    description: 'Pay-per-request LLM access over Lightning. 10 sats short, 50 sats long. Free models inside (gemini, groq).',
    version: '1.0.0',
    endpoints: [
      {
        path: '/v1/chat/completions',
        method: 'POST',
        priceSats: PRICE_CHAT,
        priceSatsLong: PRICE_LONG,
        description: 'OpenAI-compatible chat completions',
        models: ['gemini-3.6-flash', 'gpt-oss-120b'],
      },
      {
        path: '/mcp',
        method: 'POST',
        priceSats: PRICE_CHAT,
        description: 'MCP streamable-HTTP endpoint (tool: chat)',
        models: ['gemini-3.6-flash', 'gpt-oss-120b'],
      },
    ],
  });
});

// 402 Index domain verification (безопасно отдаём только hash, не raw token)
app.get('/.well-known/402index-verify.txt', (_req, res) => {
  res.type('text/plain');
  // Хэш читается из vault при старте; fallback на env для переиспользования
  const hash = (() => {
    try {
      return fs.readFileSync(path.join(VAULT_DIR, '402index_verify.txt'), 'utf8').trim();
    } catch {
      return process.env.F402INDEX_VERIFY_HASH || '';
    }
  })();
  res.send(hash);
});

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// --- MCP (Model Context Protocol) endpoint ---
// Минимальный streamable-HTTP MCP-сервер без SDK: exposes один tool `chat`.
// Совместимо с mcp.so и MCP-клиентами, которые ожидают JSON-RPC поверх HTTP.
const MCP_TOOL = {
  name: 'chat',
  description: 'Ask an LLM a question. Returns a text completion. Pay per request via Lightning (L402).',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The user prompt' },
      model: { type: 'string', enum: ['gemini-3.6-flash', 'gpt-oss-120b'], default: 'gemini-3.6-flash' },
    },
    required: ['prompt'],
  },
};

function mcpJsonRpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}
function mcpJsonRpcErr(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

// MCP-shaped 405 recovery для GET/DELETE (требование OpenTask hosted MCP)
function mcpMethodNotAllowed(res, method) {
  res.status(405);
  res.set('Content-Type', 'application/json');
  res.set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION);
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32000,
      message: `Method ${method} is not allowed for this MCP resource. Use POST with a JSON-RPC request.`,
      data: { allowedMethods: ['POST'] },
    },
  }));
}

const MCP_PROTOCOL_VERSION = '2025-03-26';

// GET /mcp и DELETE /mcp -> MCP-shaped 405 recovery
app.get('/mcp', (req, res) => mcpMethodNotAllowed(res, 'GET'));
app.delete('/mcp', (req, res) => mcpMethodNotAllowed(res, 'DELETE'));
// /api/mcp — compatibility alias для MCP-клиентов, требующих API-префикс
app.post('/api/mcp', (req, res) => { req.url = '/mcp'; app.handle(req, res); });
app.get('/api/mcp', (req, res) => mcpMethodNotAllowed(res, 'GET'));
app.delete('/api/mcp', (req, res) => mcpMethodNotAllowed(res, 'DELETE'));

app.post('/mcp', async (req, res) => {
  const body = req.body || {};
  const id = body.id ?? null;
  const method = body.method || '';
  const requestedProtocol = (body.params && body.params.protocolVersion) || MCP_PROTOCOL_VERSION;

  res.set('Content-Type', 'application/json');
  // OpenTask hosted MCP: заголовок Mcp-Protocol-Version с negotiated revision
  res.set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION);

  if (method === 'initialize') {
    res.end(mcpJsonRpc(id, {
      protocolVersion: requestedProtocol,
      capabilities: { tools: {} },
      serverInfo: { name: 'l402-llm', version: '1.0.0' },
    }));
    return;
  }
  if (method === 'notifications/initialized') {
    res.status(202).end();
    return;
  }
  if (method === 'tools/list') {
    res.end(mcpJsonRpc(id, { tools: [MCP_TOOL] }));
    return;
  }
  if (method === 'tools/call') {
    const args = body.params && body.params.arguments || {};
    const prompt = String(args.prompt || '');
    if (!prompt) {
      res.end(mcpJsonRpcErr(id, -32602, 'prompt is required'));
      return;
    }
    const chatBody = {
      model: args.model || 'gemini-3.6-flash',
      messages: [{ role: 'user', content: prompt }],
    };
    const payload = JSON.stringify(chatBody);
    const url = new URL(FRELLMAPI + '/v1/chat/completions');
    const transport = url.protocol === 'https:' ? https : http;
    const upstream = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(FRELLMAPI_KEY ? { 'Authorization': 'Bearer ' + FRELLMAPI_KEY } : {}),
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (upRes) => {
      let data = '';
      upRes.on('data', (c) => data += c);
      upRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content || data;
          res.end(mcpJsonRpc(id, { content: [{ type: 'text', text: String(text) }], isError: false }));
        } catch {
          res.end(mcpJsonRpcErr(id, -32603, 'upstream parse error: ' + data.slice(0, 200)));
        }
      });
    });
    upstream.on('error', (e) => {
      res.end(mcpJsonRpcErr(id, -32603, 'upstream error: ' + e.message));
    });
    upstream.write(payload);
    upstream.end();
    return;
  }
  if (method === 'ping') {
    res.end(mcpJsonRpc(id, {}));
    return;
  }
  res.end(mcpJsonRpcErr(id, -32601, 'method not found: ' + method));
});

const PORT = Number(process.env.L402_PORT || 3002);
app.listen(PORT, () => {
  console.log(`L402 LLM API running on http://localhost:${PORT}`);
  console.log(`Protected: POST /v1/chat/completions (${PRICE_CHAT}-${PRICE_LONG} sats)`);
  console.log(`Proxying to: ${FRELLMAPI}`);
});
