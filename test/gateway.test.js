'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { WebSocket, WebSocketServer } = require('ws');
const { readConfig, authenticateFirstMessage, createGateway } = require('../railway-xray/gateway');

const UUID = 'a34e5321-1f6b-4f31-8f87-8bf3bcb0c1df';
const PASSWORD = 'a private password / + 中文';

function vless(id = UUID, payload = Buffer.from('first payload')) {
  return Buffer.concat([
    Buffer.from([0]), Buffer.from(id.replaceAll('-', ''), 'hex'),
    Buffer.from([0, 1, 1, 187, 2, 12]), Buffer.from('example.test'), payload,
  ]);
}

function trojan(password = PASSWORD, payload = Buffer.from('first payload')) {
  return Buffer.concat([
    Buffer.from(createHash('sha224').update(password).digest('hex')),
    Buffer.from('\r\n'), Buffer.from([1, 3, 12]), Buffer.from('example.test'),
    Buffer.from([1, 187, 13, 10]), payload,
  ]);
}

function config(overrides = {}) {
  return { ...readConfig({ uuid: UUID, TROJAN_PASSWORD: PASSWORD, DOMAIN: 'node.example.test' }), ...overrides };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function setup(t, options = {}) {
  const connections = [];
  const backend = http.createServer();
  const upstream = new WebSocketServer({
    server: backend,
    perMessageDeflate: false,
    verifyClient: options.upgradeDelayMs
      ? (_info, done) => setTimeout(() => done(true), options.upgradeDelayMs)
      : undefined,
  });
  upstream.on('connection', (ws, req) => {
    connections.push(req.url);
    ws.on('error', () => {});
    ws.on('message', message => ws.send(message));
  });
  const backendPort = await listen(backend);
  const gateway = createGateway(config({ backendPort, ...options }));
  const port = await listen(gateway.server);
  t.after(async () => {
    await gateway.close();
    for (const client of upstream.clients) client.terminate();
    await new Promise(resolve => upstream.close(resolve));
    await new Promise(resolve => backend.close(resolve));
  });
  return { port, connections, upstream };
}

async function connect(t, port, path) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  ws.on('error', () => {});
  t.after(() => ws.terminate());
  await once(ws, 'open');
  return ws;
}

test('configuration requires a fixed, valid UUID', () => {
  assert.throws(() => readConfig({}), /uuid/i);
  assert.throws(() => readConfig({ uuid: 'invalid' }), /uuid/i);
  const value = readConfig({ uuid: UUID.toUpperCase(), RAILWAY_PUBLIC_DOMAIN: 'railway.example.test' });
  assert.equal(value.uuid, UUID);
  assert.equal(value.trojanPassword, UUID);
  assert.equal(value.domain, 'railway.example.test');
});

test('configuration rejects ambiguous ports and unsafe domains', () => {
  assert.throws(() => readConfig({ uuid: UUID, PORT: '3001' }), /port/i);
  assert.throws(() => readConfig({ uuid: UUID, PORT: '-1' }), /port/i);
  assert.throws(() => readConfig({ uuid: UUID, BACKEND_PORT: '123x' }), /port/i);
  assert.throws(() => readConfig({ uuid: UUID, DOMAIN: 'example.test/path' }), /domain/i);
});

test('VLESS and Trojan authentication validates the entire header', () => {
  for (const [protocol, message] of [['vless', vless()], ['trojan', trojan()]]) {
    for (let size = 0; size < (protocol === 'vless' ? 35 : 77); size++) {
      assert.equal(authenticateFirstMessage(protocol, message.subarray(0, size), config()), false);
    }
    assert.equal(authenticateFirstMessage(protocol, message, config()), true);
  }
});

test('authentication rejects wrong UUIDs, passwords, commands, and address types', () => {
  assert.throws(() => authenticateFirstMessage('vless', vless('00000000-0000-0000-0000-000000000000'), config()));
  assert.throws(() => authenticateFirstMessage('trojan', trojan('wrong password'), config()));
  for (const [protocol, offset] of [['vless', 18], ['trojan', 58]]) {
    const message = protocol === 'vless' ? vless() : trojan();
    message[offset] = 2;
    assert.throws(() => authenticateFirstMessage(protocol, message, config()), /command/i);
  }
  const message = vless(); message[21] = 99;
  assert.throws(() => authenticateFirstMessage('vless', message, config()), /address/i);
});

test('Trojan requires both CRLF delimiters', () => {
  const message = trojan(); message[56] = 0;
  assert.throws(() => authenticateFirstMessage('trojan', message, config()));
  const trailer = trojan(); trailer[75] = 0;
  assert.throws(() => authenticateFirstMessage('trojan', trailer, config()));
});

test('health check never discloses credentials and requires a reachable backend', async t => {
  const { port } = await setup(t);
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.ok(!(await response.text()).includes(UUID));
  const gateway = createGateway(config({ backendPort: 1 }));
  const unavailable = await listen(gateway.server);
  t.after(() => gateway.close());
  assert.equal((await fetch(`http://127.0.0.1:${unavailable}/`)).status, 503);
});

test('protected links use the configured domain for address, SNI and Host', async t => {
  const { port } = await setup(t);
  const response = await fetch(`http://127.0.0.1:${port}/${UUID}`);
  assert.equal(response.status, 200);
  const links = (await response.text()).trim().split('\n').map(link => new URL(link));
  assert.deepEqual(links.map(link => link.protocol), ['vless:', 'trojan:']);
  for (const link of links) {
    assert.equal(link.hostname, 'node.example.test');
    assert.equal(link.searchParams.get('sni'), 'node.example.test');
    assert.equal(link.searchParams.get('host'), 'node.example.test');
    assert.equal(link.searchParams.get('security'), 'tls');
    assert.equal(link.searchParams.get('path'), `/${link.protocol.slice(0, -1)}`);
    assert.equal(link.searchParams.has('allowInsecure'), false);
  }
  assert.equal(decodeURIComponent(links[1].username), PASSWORD);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('missing domain never falls back to an untrusted Host header', async t => {
  const { port } = await setup(t, { domain: null });
  const response = await fetch(`http://127.0.0.1:${port}/${UUID}`, { headers: { Host: 'attacker.example' } });
  assert.equal(response.status, 503);
});

test('upstream panel and disabled protocol paths are not exposed over HTTP', async t => {
  const { port } = await setup(t);
  for (const path of ['/style.css', '/vmess', '/ss', '/vless', '/trojan', '/wrong-uuid']) {
    assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 404);
  }
});

for (const protocol of ['vless', 'trojan']) {
  test(`${protocol}: authenticated headers and subsequent payload relay in order`, async t => {
    const { port, connections } = await setup(t);
    const ws = await connect(t, port, `/${protocol}`);
    const first = protocol === 'vless' ? vless() : trojan();
    const received = [];
    const complete = new Promise(resolve => {
      ws.on('message', message => {
        received.push(message);
        if (Buffer.concat(received).length === first.length + 4) resolve();
      });
    });
    ws.send(first);
    ws.send(Buffer.from('next'));
    await complete;
    assert.deepEqual(Buffer.concat(received), Buffer.concat([first, Buffer.from('next')]));
    assert.deepEqual(connections, [`/${protocol}`]);
    const closed = once(ws, 'close'); ws.close(); await closed;
  });

  test(`${protocol}: header split across messages is authenticated before forwarding`, async t => {
    const { port, connections } = await setup(t);
    const ws = await connect(t, port, `/${protocol}`);
    const first = protocol === 'vless' ? vless() : trojan();
    ws.send(first.subarray(0, 10));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(connections, []);
    const received = once(ws, 'message');
    ws.send(first.subarray(10));
    assert.deepEqual((await received)[0], first);
  });

  test(`${protocol}: invalid credentials never connect to the backend`, async t => {
    const { port, connections } = await setup(t);
    const ws = await connect(t, port, `/${protocol}`);
    const closed = once(ws, 'close');
    ws.send(protocol === 'vless' ? vless('00000000-0000-0000-0000-000000000000') : trojan('incorrect'));
    assert.equal((await closed)[0], 1008);
    assert.deepEqual(connections, []);
  });
}

test('truncated headers time out without opening an upstream connection', async t => {
  const { port, connections } = await setup(t, { authTimeoutMs: 40 });
  const ws = await connect(t, port, '/vless');
  const closed = once(ws, 'close'); ws.send(vless().subarray(0, 20));
  assert.equal((await closed)[0], 1008);
  assert.deepEqual(connections, []);
});

test('text WebSocket messages cannot bypass credential checks', async t => {
  const { port, connections } = await setup(t);
  const ws = await connect(t, port, '/vless');
  const closed = once(ws, 'close'); ws.send('not a binary protocol header');
  assert.equal((await closed)[0], 1008);
  assert.deepEqual(connections, []);
});

test('disabled WebSocket paths are rejected before upgrade', async t => {
  const { port, connections } = await setup(t);
  for (const path of ['/vmess', '/ss', '/', '/vless?path=/trojan']) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.on('error', () => {});
    const status = new Promise(resolve => ws.on('unexpected-response', (req, res) => {
      res.resume(); ws.terminate(); resolve(res.statusCode);
    }));
    assert.equal(await status, 404);
  }
  assert.deepEqual(connections, []);
});

test('backend WebSocket failures close authenticated client connections', async t => {
  const { port } = await setup(t, { backendPort: 1 });
  const ws = await connect(t, port, '/vless');
  const closed = once(ws, 'close'); ws.send(vless());
  assert.equal((await closed)[0], 1011);
});

test('oversized messages are rejected without connecting to the backend', async t => {
  const { port, connections } = await setup(t);
  const ws = await connect(t, port, '/vless');
  const closed = once(ws, 'close');
  ws.send(Buffer.alloc(1024 * 1024 + 1));
  assert.equal((await closed)[0], 1009);
  assert.deepEqual(connections, []);
});

test('messages sent during a delayed backend upgrade remain ordered', async t => {
  const { port } = await setup(t, { upgradeDelayMs: 80 });
  const ws = await connect(t, port, '/vless');
  const messages = [vless(), ...Array.from({ length: 40 }, (_, i) => Buffer.from(`queued-${i};`))];
  const expected = Buffer.concat(messages);
  const received = [];
  const complete = new Promise(resolve => ws.on('message', message => {
    received.push(message);
    if (Buffer.concat(received).length >= expected.length) resolve(Buffer.concat(received));
  }));
  for (const message of messages) ws.send(message);
  assert.deepEqual(await complete, expected);
});
