'use strict';
// Run only inside the disposable bubblewrap namespace described by the caller.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const dgram = require('node:dgram');
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
const udpEcho = dgram.createSocket('udp4');
udpEcho.on('message', (message, peer) => udpEcho.send(message, peer.port, peer.address));
let udpListening = false;
let child;
let childClosed;
let logs = '';
fs.writeFileSync('/tmp/cloudflare_tunnel_domain_tmp', 'temporary.example.test');

function receive(ws, expected, label) {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const deadline = setTimeout(() => finish(new Error(`${label} response timeout; received=${received.toString('hex')}`)), 4000);
    function finish(error) {
      clearTimeout(deadline);
      ws.removeListener('message', next);
      ws.removeListener('close', closed);
      ws.removeListener('error', finish);
      if (error) reject(error);
      else resolve(received);
    }
    function closed() { finish(new Error(`${label} WebSocket closed before its response`)); }
    function next(message) {
      received = Buffer.concat([received, message]);
      if (received.length >= expected.length) finish();
    }
    ws.on('message', next);
    ws.once('close', closed);
    ws.once('error', finish);
  });
}

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
  const label = `${route === '/' ? 'Node' : 'real Rust'} ${protocol} ${route} (${addressKind}, addon=${addon.length})`;
  try {
    await once(ws, 'open');
    const expected = protocol === 'vless' ? Buffer.concat([Buffer.from([0, 0]), payload]) : payload;
    const response = receive(ws, expected, label);
    ws.send(Buffer.concat([header, payload]));
    assert.deepEqual(await response, expected);
    const nextPayload = Buffer.from('subsequent payload');
    const second = receive(ws, nextPayload, label);
    ws.send(nextPayload);
    assert.deepEqual(await second, nextPayload);
    console.log(`PASS ${label}: authenticated TCP relay and subsequent payload`);
  } finally {
    ws.terminate();
  }
}

async function probeUdp() {
  const port = udpEcho.address().port;
  const header = Buffer.concat([
    Buffer.from([0]), Buffer.from(uuid.replaceAll('-', ''), 'hex'),
    Buffer.from([0, 2, port >> 8, port & 255, 1, 127, 0, 0, 1]),
  ]);
  const ws = new WebSocket('ws://127.0.0.1:3000/');
  ws.on('error', () => {});
  try {
    await once(ws, 'open');
    for (const [index, text] of ['first UDP datagram', 'subsequent UDP datagram'].entries()) {
      const payload = Buffer.from(text);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(payload.length);
      const datagram = Buffer.concat([length, payload]);
      const expected = index === 0 ? Buffer.concat([Buffer.from([0, 0]), datagram]) : datagram;
      const response = receive(ws, expected, 'Node vless / UDP cmd=2');
      ws.send(index === 0 ? Buffer.concat([header, datagram]) : datagram);
      assert.deepEqual(await response, expected);
    }
    console.log('PASS Node vless / UDP cmd=2: local datagram relay and subsequent datagram in default both mode');
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
  udpEcho.bind(0, '127.0.0.1');
  await once(udpEcho, 'listening');
  udpListening = true;
  child = spawn(process.execPath, ['/app/index.js'], {
    env: { PATH: '/usr/bin:/bin', uuid, TROJAN_PASSWORD: password, PORT: '3000', BACKEND_PORT: '3001', CLOUDFLARE_TUNNEL_DOMAIN: 'fixed.example.test', TUNNEL_STATE_DIR: '/tmp', CF_IP: '192.0.2.10', XRAY_BINARY: '/tmp/backend-launcher' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  childClosed = new Promise(resolve => child.once('close', resolve));
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
  assert.equal(links.length, 12);
  assert.equal(links.filter(link => link.protocol === 'vless:').length, 8);
  assert.equal(links.filter(link => link.protocol === 'trojan:').length, 4);
  assert.equal(new Set(links.map(link => link.hash)).size, 12, 'Node and Rust node names must be distinct');
  const domains = ['fixed.example.test', 'temporary.example.test'];
  for (const route of ['/', '/vless', '/trojan']) {
    const group = links.filter(link => link.searchParams.get('path') === route);
    assert.equal(group.length, 4, `Expected four nodes on ${route}`);
    for (const link of group) {
      const domain = link.searchParams.get('sni');
      assert.ok(domains.includes(domain));
      assert.equal(link.searchParams.get('host'), domain);
      assert.equal(link.searchParams.get('security'), 'tls');
      assert.equal(link.searchParams.get('type'), 'ws');
      assert.equal(link.protocol, route === '/trojan' ? 'trojan:' : 'vless:');
      assert.equal(decodeURIComponent(link.username), route === '/trojan' ? password : uuid);
    }
    for (const domain of domains) {
      assert.deepEqual(group.filter(link => link.searchParams.get('sni') === domain).map(link => link.hostname).sort(), [domain, '192.0.2.10'].sort());
    }
  }
  const yaml = await (await fetch(`http://127.0.0.1:3000/${uuid}/clash`)).text();
  assert.equal((yaml.match(/udp: true/g) || []).length, 4);
  assert.equal((yaml.match(/udp: false/g) || []).length, 8);
  const proxySection = yaml.split('\nproxies:\n')[1].split('\nproxy-groups:')[0];
  const proxyBlocks = proxySection.split(/(?=^  - name:)/m).filter(block => /^  - name:/m.test(block));
  assert.equal(proxyBlocks.length, 12);
  for (const block of proxyBlocks) {
    const route = block.match(/^      path: (.+)$/m)[1].trim().replace(/^"|"$/g, '');
    assert.ok(['/', '/vless', '/trojan'].includes(route));
    assert.match(block, route === '/' ? /^    udp: true$/m : /^    udp: false$/m);
    assert.match(block, route === '/trojan' ? /^    type: trojan$/m : /^    type: vless$/m);
  }
  assert.ok(yaml.includes('name: Auto-Fallback') && yaml.includes('name: cf-ip'));
  console.log('PASS default both subscriptions: 12 links across two tunnels and preferred IP; Node / has UDP enabled, Rust /vless and /trojan are TCP only');
  await probe('vless', 'ipv4', Buffer.alloc(0), '/');
  await probeUdp();
  await probe('vless');
  await probe('trojan');
  await probe('vless', 'domain');
  await probe('trojan', 'domain');
  await probe('vless', 'ipv4', Buffer.from([0, 0]));
  const closed = once(child, 'exit');
  child.kill('SIGTERM');
  assert.equal((await closed)[0], 0);
  await childClosed;
  console.log('PASS real supervisor: SIGTERM exits cleanly');
})().catch(error => {
  console.error(error.stack);
  console.error(logs);
  process.exitCode = 1;
}).finally(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (childClosed) await childClosed;
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => echo.close(resolve));
  if (udpListening) await new Promise(resolve => udpEcho.close(resolve));
});
