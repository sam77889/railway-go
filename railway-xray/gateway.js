'use strict';

const http = require('node:http');
const net = require('node:net');
const { createHash, timingSafeEqual } = require('node:crypto');
const { WebSocket, WebSocketServer, createWebSocketStream } = require('ws');

const MAX_PAYLOAD = 1024 * 1024;
const MAX_HEADER = 8192;

function readPort(value, fallback) {
  const text = value === undefined || value === '' ? String(fallback) : String(value);
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 65535) {
    throw new Error('PORT and BACKEND_PORT must be integers between 1 and 65535');
  }
  return Number(text);
}

function readConfig(env) {
  const uuid = (env.uuid || '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
    throw new Error('Set uuid to your own fixed UUID before starting');
  }
  const port = readPort(env.PORT, 3000);
  const backendPort = readPort(env.BACKEND_PORT, 3001);
  if (port === backendPort) throw new Error('PORT and BACKEND_PORT must differ');
  const domain = (env.DOMAIN || env.RAILWAY_PUBLIC_DOMAIN || '').trim().toLowerCase() || null;
  if (domain && (domain.length > 253 || !domain.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) {
    throw new Error('DOMAIN must be a hostname without a scheme, port or path');
  }
  const trojanPassword = env.TROJAN_PASSWORD || uuid;
  return {
    port, backendPort, uuid, trojanPassword, domain,
    uuidBytes: Buffer.from(uuid.replaceAll('-', ''), 'hex'),
    trojanHash: Buffer.from(createHash('sha224').update(trojanPassword).digest('hex')),
    name: env.NAME || 'Railway-Xray',
    authTimeoutMs: 10000,
    backendTimeoutMs: 5000,
  };
}

// Return false while a header is incomplete. Reject invalid credentials and
// unsupported commands before the gateway creates any backend connection.
function authenticateFirstMessage(protocol, message, config) {
  if (!Buffer.isBuffer(message)) throw new Error('Binary messages required');
  let offset;
  let addressType;
  if (protocol === 'vless') {
    if (message.length < 1) return false;
    if (message[0] !== 0) throw new Error('Unsupported VLESS version');
    if (message.length < 17) return false;
    if (!timingSafeEqual(message.subarray(1, 17), config.uuidBytes)) {
      throw new Error('Invalid credentials');
    }
    if (message.length < 18) return false;
    offset = 18 + message[17];
    if (message.length < offset + 4) return false;
    if (message[offset] !== 1) throw new Error('Only TCP command is supported');
    if (message.readUInt16BE(offset + 1) === 0) throw new Error('Invalid destination port');
    addressType = message[offset + 3];
    offset += 4;
  } else if (protocol === 'trojan') {
    if (message.length < 56) return false;
    if (!timingSafeEqual(message.subarray(0, 56), config.trojanHash)) {
      throw new Error('Invalid credentials');
    }
    if (message.length < 60) return false;
    if (message[56] !== 13 || message[57] !== 10) throw new Error('Invalid delimiter');
    if (message[58] !== 1) throw new Error('Only TCP command is supported');
    addressType = message[59];
    offset = 60;
  } else {
    throw new Error('Unsupported protocol');
  }

  const ipv4 = 1;
  const domain = protocol === 'vless' ? 2 : 3;
  const ipv6 = protocol === 'vless' ? 3 : 4;
  let addressLength;
  if (addressType === ipv4) addressLength = 4;
  else if (addressType === ipv6) addressLength = 16;
  else if (addressType === domain) {
    if (message.length < offset + 1) return false;
    addressLength = message[offset++];
    if (addressLength === 0) throw new Error('Invalid destination address');
  } else throw new Error('Unsupported address type');

  offset += addressLength;
  if (protocol === 'trojan') {
    if (message.length < offset + 4) return false;
    if (message.readUInt16BE(offset) === 0) throw new Error('Invalid destination port');
    if (message[offset + 2] !== 13 || message[offset + 3] !== 10) {
      throw new Error('Invalid delimiter');
    }
    offset += 4;
  }
  return message.length >= offset;
}

function closeWebSocket(ws, code, reason) {
  if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
  else if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
  if (ws.readyState !== WebSocket.CLOSED) {
    const timer = setTimeout(() => ws.terminate(), 1000);
    timer.unref();
    ws.once('close', () => clearTimeout(timer));
  }
}

function connectBackend(client, protocol, firstMessage, config) {
  const backend = new WebSocket(`ws://127.0.0.1:${config.backendPort}/${protocol}`, {
    perMessageDeflate: false,
    maxPayload: MAX_PAYLOAD,
    handshakeTimeout: config.backendTimeoutMs,
  });
  let closing = false;
  function close(code = 1011, reason = 'Backend unavailable') {
    if (closing) return;
    closing = true;
    closeWebSocket(client, code, reason);
    closeWebSocket(backend, code, reason);
  }
  client.on('error', () => close());
  backend.on('error', () => close());
  client.once('close', () => close(1000, 'Client closed'));
  backend.once('close', code => close(code === 1000 ? 1000 : 1011, 'Backend closed'));

  // ws streams pause their underlying socket when the receiving stream is full.
  // Creating them immediately also preserves messages arriving during upgrade.
  const inbound = createWebSocketStream(client, { highWaterMark: 64 * 1024 });
  const outbound = createWebSocketStream(backend, { highWaterMark: 64 * 1024 });
  inbound.on('error', () => close());
  outbound.on('error', () => close());
  client.once('close', () => { inbound.destroy(); outbound.destroy(); });
  outbound.write(firstMessage);
  inbound.pipe(outbound).pipe(inbound);
}

function checkBackend(config, done) {
  const socket = net.connect({ host: '127.0.0.1', port: config.backendPort });
  let finished = false;
  function finish(ready) {
    if (finished) return;
    finished = true;
    socket.destroy();
    done(ready);
  }
  socket.setTimeout(1000);
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.once('timeout', () => finish(false));
}

function buildLinks(config) {
  return ['vless', 'trojan'].map(protocol => {
    const credential = protocol === 'vless' ? config.uuid : config.trojanPassword;
    const link = new URL(`${protocol}://${encodeURIComponent(credential)}@${config.domain}:443`);
    if (protocol === 'vless') link.searchParams.set('encryption', 'none');
    for (const [key, value] of Object.entries({
      security: 'tls', sni: config.domain, type: 'ws', host: config.domain, path: `/${protocol}`,
    })) link.searchParams.set(key, value);
    link.hash = `${config.name}-${protocol}`;
    return link.href;
  }).join('\n') + '\n';
}

function createGateway(config, options = {}) {
  const sockets = new Set();
  const server = http.createServer({ noDelay: true }, options.requestHandler || ((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' }); res.end('Method not allowed\n'); return;
    }
    if (req.url === '/') {
      checkBackend(config, ready => {
        if (res.destroyed) return;
        res.writeHead(ready ? 200 : 503);
        res.end(ready ? 'Railway Xray gateway ready\n' : 'Backend unavailable\n');
      });
      return;
    }
    if (req.url === `/${config.uuid}`) {
      res.statusCode = config.domain ? 200 : 503;
      res.end(config.domain ? buildLinks(config) : 'Set DOMAIN or generate a Railway public domain\n');
      return;
    }
    res.writeHead(404); res.end('Not found\n');
  }));
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const wss = new WebSocketServer({
    noServer: true, perMessageDeflate: false, maxPayload: MAX_PAYLOAD,
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/' && options.rootUpgrade) {
      options.rootUpgrade(req, socket, head);
      return;
    }
    const protocol = req.url === '/vless' || (options.vlessRoot && req.url === '/')
      ? 'vless' : req.url === '/trojan' ? 'trojan' : null;
    if (!protocol) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => {});
      let pending = Buffer.alloc(0);
      const timer = setTimeout(() => closeWebSocket(ws, 1008, 'Authentication timed out'), config.authTimeoutMs);
      timer.unref();
      ws.once('close', () => clearTimeout(timer));
      function authenticate(message, isBinary) {
        try {
          if (!isBinary) throw new Error('Binary messages required');
          if (pending.length + message.length > MAX_PAYLOAD) throw new Error('Message too large');
          pending = pending.length ? Buffer.concat([pending, message]) : Buffer.from(message);
          if (!authenticateFirstMessage(protocol, pending, config)) {
            if (pending.length > MAX_HEADER) throw new Error('Header too large');
            return;
          }
          clearTimeout(timer);
          ws.removeListener('message', authenticate);
          connectBackend(ws, protocol, pending, config);
          pending = null;
        } catch {
          clearTimeout(timer);
          ws.removeListener('message', authenticate);
          closeWebSocket(ws, 1008, 'Invalid protocol or credentials');
        }
      }
      ws.on('message', authenticate);
    });
  });

  async function close() {
    for (const client of wss.clients) client.terminate();
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise(resolve => wss.close(resolve)),
      new Promise(resolve => server.close(resolve)),
    ]);
  }
  return { server, close };
}

module.exports = { readConfig, authenticateFirstMessage, createGateway, checkBackend };
