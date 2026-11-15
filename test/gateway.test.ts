import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

let upstream: ReturnType<typeof createServer>;
let gateway: ReturnType<typeof spawn>;
let upstreamUrl: string;
let gatewayUrl = 'http://127.0.0.1:18787';

test.before(async () => {
  upstream = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'free-test-model', object: 'model' }] })); }
    if (req.url === '/v1/chat/completions') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] })); }
    if (req.url === '/v1/messages') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ id: 'msg_x', model: 'free-test-model', content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn' })); }
    res.writeHead(404); res.end();
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}`;
  gateway = spawn(process.execPath, ['--experimental-strip-types', 'main.ts'], { cwd: process.cwd(), env: { ...process.env, PORT: '18787', MAKEFUN_ENV_URL: upstreamUrl }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 300));
});
test.after(() => { gateway.kill(); upstream.close(); });

test('catalog proxies models', async () => { const r = await fetch(`${gatewayUrl}/v1/models`); assert.equal(r.status, 200); assert.equal((await r.json()).data[0].id, 'free-test-model'); });
test('OpenAI chat completion', async () => { const r = await fetch(`${gatewayUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'free-test-model', messages: [{ role: 'user', content: 'ping' }] }) }); const d = await r.json(); assert.equal(d.choices[0].message.content, 'pong'); });
test('Anthropic messages adapts to OpenAI response', async () => { const r = await fetch(`${gatewayUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'free-test-model', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] }) }); const d = await r.json(); assert.equal(d.object, 'chat.completion'); assert.equal(d.choices[0].message.content, 'pong'); });
