#!/usr/bin/env node
/** Deterministic, dependency-free OpenAI/Anthropic compatible free-model gateway. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8787);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 60_000);
const baseUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/$/, '');
const configuredModels = (process.env.FREE_MODELS ?? '').split(',').map(s => s.trim()).filter(Boolean);

type Json = Record<string, any>;
type Target = { url: string; name: string; headers?: Record<string, string> };

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}
function error(res: ServerResponse, status: number, message: string, type = 'invalid_request_error') {
  json(res, status, { error: { message, type, param: null, code: String(status) } });
}
async function body(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Request body must be valid JSON'); }
}
function targets(): Target[] {
  if (!baseUrl) return [];
  const raw = (process.env.MAKEFUN_UPSTREAMS ?? baseUrl).split(',').map(s => s.trim()).filter(Boolean);
  return raw.map((url, i) => ({ url: url.replace(/\/$/, ''), name: `upstream-${i + 1}` }));
}
function upstreamPath(path: string) { return path.startsWith('/v1/') ? path : `/v1${path}`; }
function authHeaders(req: IncomingMessage, extra: Record<string, string> = {}) {
  const h: Record<string, string> = { accept: req.headers.accept ?? 'application/json', ...extra };
  for (const key of ['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta']) {
    const value = req.headers[key]; if (typeof value === 'string') h[key] = value;
  }
  return h;
}
async function fetchWithTimeout(url: string, init: RequestInit) {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return fetch(url, { ...init, signal });
}
async function catalog(): Promise<Json[]> {
  if (configuredModels.length) return configuredModels.map(id => ({ id, object: 'model', owned_by: 'free-model-aggregator' }));
  for (const target of targets()) {
    try {
      const r = await fetchWithTimeout(`${target.url}/v1/models`, { headers: { accept: 'application/json' } });
      if (r.ok) { const d = await r.json() as Json; if (Array.isArray(d.data)) return d.data; }
    } catch { /* fail over */ }
  }
  return [];
}
function openAIError(status: number, detail: string) { return { error: { message: detail, type: 'upstream_error', param: null, code: String(status) } }; }
function anthropicRequest(input: Json): Json {
  const system = typeof input.system === 'string' ? [{ role: 'system', content: input.system }] : [];
  const messages = [...system, ...(Array.isArray(input.messages) ? input.messages : [])];
  return { ...input, messages, model: input.model, stream: Boolean(input.stream) };
}
function openAIToAnthropic(input: Json): Json {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const system = messages.filter((m: Json) => m.role === 'system').map((m: Json) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  const rest = messages.filter((m: Json) => m.role !== 'system');
  return { model: input.model, messages: rest, ...(system ? { system } : {}), max_tokens: input.max_tokens ?? input.max_completion_tokens ?? 1024, temperature: input.temperature, top_p: input.top_p, stream: Boolean(input.stream), tools: input.tools, tool_choice: input.tool_choice, response_format: input.response_format };
}
function anthropicToOpenAI(d: Json, model: string): Json {
  const content = Array.isArray(d.content) ? d.content : [{ type: 'text', text: d.content ?? '' }];
  const text = content.filter((x: Json) => x.type === 'text').map((x: Json) => x.text).join('');
  const toolCalls = content.filter((x: Json) => x.type === 'tool_use').map((x: Json) => ({ id: x.id, type: 'function', function: { name: x.name, arguments: JSON.stringify(x.input ?? {}) } }));
  return { id: d.id ?? `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: d.model ?? model, choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: d.stop_reason ?? (toolCalls.length ? 'tool_calls' : 'stop') }], usage: d.usage };
}
async function relay(req: IncomingMessage, res: ServerResponse, path: string, input: Json, asAnthropic: boolean) {
  const list = targets();
  if (!list.length) return error(res, 503, 'No MAKEFUN_ENV_URL configured');
  const payload = asAnthropic ? anthropicRequest(input) : input;
  const isStream = Boolean(input.stream);
  let last = 'All upstreams failed';
  for (const target of list) {
    try {
      const upstream = asAnthropic ? '/v1/messages' : upstreamPath(path);
      const r = await fetchWithTimeout(`${target.url}${upstream}`, { method: 'POST', headers: authHeaders(req, { 'content-type': 'application/json' }), body: JSON.stringify(payload) });
      if (!r.ok) { last = `${target.name}: ${r.status} ${await r.text().catch(() => '')}`; continue; }
      if (isStream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        if (!r.body) { res.end(); return; }
        const reader = r.body.getReader();
        while (true) { const part = await reader.read(); if (part.done) break; res.write(Buffer.from(part.value)); }
        res.end(); return;
      }
      const data = await r.json() as Json;
      return json(res, 200, asAnthropic ? anthropicToOpenAI(data, input.model ?? 'unknown') : data);
    } catch (e) { last = `${target.name}: ${e instanceof Error ? e.message : String(e)}`; }
  }
  json(res, 502, openAIError(502, last));
}
async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) return json(res, 200, { ok: true, service: 'free-model-aggregator', configured: targets().length > 0 });
  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) return json(res, 200, { object: 'list', data: await catalog() });
  const isAnthropic = req.method === 'POST' && url.pathname === '/v1/messages';
  const isOpenAI = req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions' || url.pathname === '/v1/completions');
  if (!isAnthropic && !isOpenAI) return error(res, 404, 'Not found');
  try { const input = await body(req); return relay(req, res, url.pathname, isAnthropic ? openAIToAnthropic(input) : input, isAnthropic); }
  catch (e) { return error(res, 400, e instanceof Error ? e.message : 'Invalid request'); }
}

if (import.meta.main) createServer((req, res) => { handler(req, res).catch(e => error(res, 500, String(e))); }).listen(PORT, () => console.log(`free-model-aggregator listening on :${PORT}`));
export { handler, catalog };
