'use strict';
// Run only inside the disposable bubblewrap namespace described by the caller.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { WebSocket } = require('/app/node_modules/ws');

const uuid = '463a8357-67ac-4c80-a913-9929ff134fc8';
const password = 'isolated-smoke-test-only';
const sockets = new Set();
const echo = net.createServer(socket => {
  sockets.add(socket);
  socket.on('error', () => {});
  socket.once('close', () => sockets.delete(socket));
  socket.pipe(socket);
});
let child;
let logs = '';
fs.writeFileSync('/tmp/cloudflare_tunnel_domain_tmp', 'temporary.example.test');

async function probe(protocol, addressKind = 'ipv4', addon = Buffer.alloc(0), route = `/${protocol}`) {
  const port = echo.address().port;
  const destination = Buffer.from([port >> 8, port & 255]);
  const address = addressKind === 'domain'
    ? Buffer.concat([Buffer.from([9]), Buffer.from('127.0.0.1')])
    : Buffer.from([127, 0, 0, 1]);
  const addressType = addressKind === 'domain' ? (protocol === 'vless' ? 2 : 3) : 1;
  const payload = Buffer.from(`${protocol}:first-payload`);
  const header = protocol === 'vless'
    ? Buffer.concat([Buffer.from([0]), Buffer.from(uuid.replaceAll('-', ''), 'hex'), Buffer.from([addon.length]), addon, Buffer.from([1]), destination, Buffer.from([addressType]), address])
    : Buffer.concat([Buffer.from(createHash('sha224').update(password).digest('hex')), Buffer.from([13, 10, 1, addressType]), address, destination, Buffer.from([13, 10])]);
  const ws = new WebSocket(`ws://127.0.0.1:3000${route}`);
  ws.on('error', () => {});
  try {
    await once(ws, 'open');
    const expected = protocol === 'vless' ? Buffer.concat([Buffer.from([0, 0]), payload]) : payload;
    let received = Buffer.alloc(0);
    const response = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`${protocol} response timeout; received=${received.toString('hex')}`)), 4000);
      ws.on('message', message => {
        received = Buffer.concat([received, message]);
        if (received.length >= expected.length) {
          clearTimeout(deadline);
          resolve(received);
        }
      });
    });
    ws.send(Buffer.concat([header, payload]));
    assert.deepEqual(await response, expected);
    const second = once(ws, 'message');
    ws.send(Buffer.from('subsequent payload'));
    assert.deepEqual((await second)[0], Buffer.from('subsequent payload'));
    console.log(`PASS real Rust ${protocol} (${addressKind}, addon=${addon.length}): authenticated TCP relay and subsequent payload`);
  } finally {
    ws.terminate();
  }
}

(async () => {
  assert.ok(fs.existsSync('/backend') && !fs.existsSync('/home/san'), 'Disposable namespace required');
  const loader = process.arch === 'arm64' ? '/lib/ld-linux-aarch64.so.1' : '/lib64/ld-linux-x86-64.so.2';
  fs.writeFileSync('/tmp/backend-launcher', `#!/bin/sh\nexec ${loader} /backend\n`, { mode: 0o700 });
  echo.listen(0, '127.0.0.1');
  await once(echo, 'listening');
  child = spawn(process.execPath, ['/app/index.js'], {
    env: { PATH: '/usr/bin:/bin', uuid, TROJAN_PASSWORD: password, PORT: '3000', BACKEND_PORT: '3001', PROXY_BACKEND: 'railway-xray', CLOUDFLARE_TUNNEL_DOMAIN: 'fixed.example.test', TUNNEL_STATE_DIR: '/tmp', CF_IP: '192.0.2.10', XRAY_BINARY: '/tmp/backend-launcher' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', data => { logs = (logs + data.toString()).slice(-20000); });
  child.stderr.on('data', data => { logs = (logs + data.toString()).slice(-20000); });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Gateway quit: ${logs}`);
    try { ready = (await fetch('http://127.0.0.1:3000/')).status === 200; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, `Backend did not become ready: ${logs}`);
  const links = (await (await fetch(`http://127.0.0.1:3000/${uuid}`)).text()).trim().split('\n').map(value => new URL(value));
  assert.equal(links.length, 8);
  assert.equal(links.filter(link => link.protocol === 'trojan:').length, 4);
  const yaml = await (await fetch(`http://127.0.0.1:3000/${uuid}/clash`)).text();
  assert.equal((yaml.match(/udp: false/g) || []).length, 8);
  assert.ok(yaml.includes('name: Auto-Fallback') && yaml.includes('name: cf-ip'));
  console.log('PASS merged subscriptions: two tunnels, preferred IP, VLESS/Trojan and TCP-only YAML');
  await probe('vless', 'ipv4', Buffer.alloc(0), '/');
  await probe('vless');
  await probe('trojan');
  await probe('vless', 'domain');
  await probe('trojan', 'domain');
  await probe('vless', 'ipv4', Buffer.from([0, 0]));
  const closed = once(child, 'exit');
  child.kill('SIGTERM');
  assert.equal((await closed)[0], 0);
  console.log('PASS real supervisor: SIGTERM exits cleanly');
})().catch(error => {
  console.error(error.stack);
  console.error(logs);
  process.exitCode = 1;
}).finally(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => echo.close(resolve));
});
