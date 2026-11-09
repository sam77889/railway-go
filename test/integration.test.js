'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { WebSocket } = require('ws');

const ROOT = path.resolve(__dirname, '..');
const UUID = '6d968cef-897f-4ac0-9615-e0f20770cbca';
const PASSWORD = 'private: password / +\n中文';

async function freePorts() {
  const servers = [net.createServer(), net.createServer()];
  try {
    for (const server of servers) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
    return servers.map(server => server.address().port);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
}

async function start(t, options = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudflare-xray-integration-'));
  const [port, backendPort] = await freePorts();
  fs.writeFileSync(path.join(folder, 'cloudflare_tunnel_domain_tmp'), 'temporary.example.test');
  const capture = path.join(folder, 'messages.jsonl');
  const binary = path.join(folder, 'fake-backend');
  fs.writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const http = require('node:http');
const {WebSocketServer} = require(${JSON.stringify(require.resolve('ws'))});
const server = http.createServer();
const wss = new WebSocketServer({server});
wss.on('connection', (ws, req) => {
  fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(req.url) + '\\n');
  ws.on('error', () => {});
  ws.on('message', message => ws.send(message));
});
process.on('SIGTERM', () => {
  for (const ws of wss.clients) ws.terminate();
  server.close(() => process.exit(0));
  if (!server.listening) process.exit(0);
});
${options.silentBackend ? 'setInterval(() => {}, 1000);' : "server.listen(Number(process.env.PORT), '127.0.0.1');"}
`, { mode: 0o755 });
  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    detached: true,
    env: {
      PATH: process.env.PATH, uuid: UUID, TROJAN_PASSWORD: PASSWORD,
      PORT: String(port), BACKEND_PORT: String(backendPort),
      CLOUDFLARE_TUNNEL_DOMAIN: 'fixed.example.test',
      TUNNEL_STATE_DIR: folder, CF_IP: '192.0.2.10,192.0.2.20',
      NAME: 'merge-test', XRAY_BINARY: options.missingBinary ? path.join(folder, 'missing') : binary,
      ...(options.mode ? { PROXY_BACKEND: options.mode } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    let killTimer;
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => { killTimer = setTimeout(resolve, 7000); })]);
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await exited;
    } finally { clearTimeout(killTimer); fs.rmSync(folder, { recursive: true, force: true }); }
  });
  if (options.expectExit) return { child, exited, logs: () => logs };
  const expected = options.silentBackend ? 503 : 200;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Application exited: ${logs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      await response.text();
      if (response.status === expected) return { port, capture, child, exited, logs: () => logs };
    } catch {}
    await delay(20);
  }
  throw new Error(`Application did not become ready: ${logs}`);
}

async function socket(t, port, route) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${route}`);
  ws.on('error', () => {});
  t.after(() => ws.terminate());
  await once(ws, 'open');
  return ws;
}

function header(port, command = 1) {
  return Buffer.concat([
    Buffer.from([0]), Buffer.from(UUID.replaceAll('-', ''), 'hex'),
    Buffer.from([0, command, port >> 8, port & 255, 1, 127, 0, 0, 1]),
  ]);
}

function trojanHeader(port) {
  return Buffer.concat([
    Buffer.from(createHash('sha224').update(PASSWORD).digest('hex')),
    Buffer.from([13, 10, 1, 1, 127, 0, 0, 1, port >> 8, port & 255, 13, 10]),
  ]);
}

function receive(ws, size) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => { ws.removeListener('message', next); reject(new Error('Response timeout')); }, 3000);
    function next(message) {
      bytes = Buffer.concat([bytes, message]);
      if (bytes.length >= size) { clearTimeout(timer); ws.removeListener('message', next); resolve(bytes); }
    }
    ws.on('message', next);
  });
}

test('default Node mode retains both tunnel subscriptions and the independent cf-ip group', { timeout: 12000 }, async t => {
  const app = await start(t, { missingBinary: true });
  const links = (await (await fetch(`http://127.0.0.1:${app.port}/${UUID}`)).text()).trim().split('\n').map(value => new URL(value));
  assert.equal(links.length, 6);
  assert.ok(links.every(link => link.protocol === 'vless:' && link.searchParams.get('path') === '/'));
  assert.equal(links.filter(link => link.hostname === '192.0.2.10').length, 2);
  assert.deepEqual(new Set(links.map(link => link.searchParams.get('sni'))), new Set(['fixed.example.test', 'temporary.example.test']));
  const yaml = await (await fetch(`http://127.0.0.1:${app.port}/${UUID}/clash`)).text();
  assert.equal((yaml.match(/type: vless/g) || []).length, 6);
  assert.equal((yaml.match(/udp: true/g) || []).length, 6);
  assert.match(yaml, /name: cf-ip\n    type: url-test/);
  const fallback = yaml.split('name: Auto-Fallback')[1].split('name: cf-ip')[0];
  assert.ok(!fallback.includes('Cloudflare-Tunnel-Fixed-1'));
});

test('default Node mode still relays VLESS TCP on the original root path', { timeout: 12000 }, async t => {
  const clients = new Set();
  const echo = net.createServer(client => {
    clients.add(client);
    client.once('close', () => clients.delete(client));
    client.pipe(client);
  });
  echo.listen(0, '127.0.0.1'); await once(echo, 'listening');
  t.after(() => {
    for (const client of clients) client.destroy();
    return new Promise(resolve => echo.close(resolve));
  });
  const app = await start(t);
  const ws = await socket(t, app.port, '/');
  const payload = Buffer.from('existing VLESS TCP');
  const response = receive(ws, payload.length + 2);
  ws.send(Buffer.concat([header(echo.address().port), payload]));
  assert.deepEqual(await response, Buffer.concat([Buffer.from([0, 0]), payload]));
  ws.close(); await once(ws, 'close');
});

test('default Node mode retains VLESS UDP relay', { timeout: 12000 }, async t => {
  const echo = dgram.createSocket('udp4');
  echo.on('message', (message, peer) => echo.send(message, peer.port, peer.address));
  echo.bind(0, '127.0.0.1'); await once(echo, 'listening');
  t.after(() => new Promise(resolve => echo.close(resolve)));
  const app = await start(t);
  const ws = await socket(t, app.port, '/');
  const payload = Buffer.from('existing UDP');
  const frame = Buffer.alloc(2); frame.writeUInt16BE(payload.length);
  const response = receive(ws, 4 + payload.length);
  ws.send(Buffer.concat([header(echo.address().port, 2), frame, payload]));
  assert.deepEqual(await response, Buffer.concat([Buffer.from([0, 0]), frame, payload]));
  ws.close(); await once(ws, 'close');
});

test('default Node mode retains Mihomo XUDP relay', { timeout: 12000 }, async t => {
  const echo = dgram.createSocket('udp4');
  echo.on('message', (message, peer) => echo.send(message, peer.port, peer.address));
  echo.bind(0, '127.0.0.1'); await once(echo, 'listening');
  t.after(() => new Promise(resolve => echo.close(resolve)));
  const app = await start(t);
  const ws = await socket(t, app.port, '/');
  const targetPort = echo.address().port;
  const address = Buffer.from([targetPort >> 8, targetPort & 255, 1, 127, 0, 0, 1]);
  const meta = Buffer.alloc(2 + 5 + address.length + 8);
  meta.writeUInt16BE(meta.length - 2); meta[4] = 1; meta[5] = 1; meta[6] = 2; address.copy(meta, 7);
  const payload = Buffer.from('existing XUDP');
  const length = Buffer.alloc(2); length.writeUInt16BE(payload.length);
  const response = receive(ws, 2 + 2 + 5 + address.length + 2 + payload.length);
  ws.send(Buffer.concat([header(666, 3), meta, length, payload]));
  const actual = await response;
  assert.deepEqual(actual.subarray(-payload.length), payload);
  assert.equal(actual[6], 2); // Keep frame in the response, after VLESS response header.
  ws.close(); await once(ws, 'close');
});

test('Rust subscriptions include VLESS and Trojan across both tunnels and preferred IPs', { timeout: 12000 }, async t => {
  const app = await start(t, { mode: 'railway-xray' });
  const links = (await (await fetch(`http://127.0.0.1:${app.port}/${UUID}`)).text()).trim().split('\n').map(value => new URL(value));
  assert.equal(links.length, 12);
  assert.equal(links.filter(link => link.protocol === 'trojan:').length, 6);
  for (const link of links) {
    const trojan = link.protocol === 'trojan:';
    assert.equal(link.searchParams.get('path'), trojan ? '/trojan' : '/');
    assert.equal(link.searchParams.get('host'), link.searchParams.get('sni'));
    if (trojan) assert.equal(decodeURIComponent(link.username), PASSWORD);
  }
  const yaml = await (await fetch(`http://127.0.0.1:${app.port}/${UUID}/clash`)).text();
  assert.equal((yaml.match(/type: vless/g) || []).length, 6);
  assert.equal((yaml.match(/type: trojan/g) || []).length, 6);
  assert.equal((yaml.match(/udp: false/g) || []).length, 12);
  assert.ok(yaml.includes(`password: ${JSON.stringify(PASSWORD)}`));
  assert.equal((yaml.match(/udp: true/g) || []).length, 0);
});

for (const route of ['/', '/vless', '/trojan']) {
  test(`Rust mode authenticates and forwards ${route} through the selected backend`, { timeout: 12000 }, async t => {
    const app = await start(t, { mode: 'railway-xray' });
    const ws = await socket(t, app.port, route);
    const data = Buffer.concat([route === '/trojan' ? trojanHeader(443) : header(443), Buffer.from('payload')]);
    const response = receive(ws, data.length);
    ws.send(data);
    assert.deepEqual(await response, data);
    assert.equal(fs.readFileSync(app.capture, 'utf8').trim(), JSON.stringify(route === '/trojan' ? '/trojan' : '/vless'));
    ws.close(); await once(ws, 'close');
  });
}

test('Rust mode rejects wrong credentials without connecting to the backend', { timeout: 12000 }, async t => {
  const app = await start(t, { mode: 'railway-xray' });
  const ws = await socket(t, app.port, '/');
  const data = header(443); data[1] ^= 255;
  const closed = once(ws, 'close'); ws.send(data);
  assert.equal((await closed)[0], 1008);
  assert.equal(fs.existsSync(app.capture), false);
});

test('Rust mode does not expose unsupported paths or upstream HTTP pages', { timeout: 12000 }, async t => {
  const app = await start(t, { mode: 'railway-xray' });
  for (const route of ['/vmess', '/ss', '/style.css', '/trojan']) {
    assert.equal((await fetch(`http://127.0.0.1:${app.port}${route}`)).status, 404);
  }
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/vmess`);
  ws.on('error', () => {});
  const response = new Promise(resolve => ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); }));
  assert.equal(await response, 404);
});

test('Rust health check fails while its process has not opened the backend port', { timeout: 12000 }, async t => {
  const app = await start(t, { mode: 'railway-xray', silentBackend: true });
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/`)).status, 503);
});

test('an invalid backend selector exits instead of silently starting Node mode', { timeout: 12000 }, async t => {
  const app = await start(t, { mode: 'typo', expectExit: true });
  let timer;
  const result = await Promise.race([app.exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); })]);
  clearTimeout(timer);
  assert.deepEqual(result, { code: 1, signal: null });
  assert.match(app.logs(), /PROXY_BACKEND/);
});
