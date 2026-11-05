const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const http = require('node:http');
const tls = require('node:tls');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { readConfig, buildServerConfig, buildClientConfig } = require('../lib/config');

const binary = process.env.XRAY_BIN;
const mihomo = process.env.MIHOMO_BIN;
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xray-integration-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const config = readConfig({
        SERVER_ADDRESS: '203.0.113.10', REALITY_SERVER_NAME: 'www.example.com',
        REALITY_PRIVATE_KEY: crypto.generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' }).d,
        REALITY_SHORT_ID: crypto.randomBytes(8).toString('hex'),
        VLESS_CLIENTS: JSON.stringify([{ name: 'test', id: crypto.randomUUID() }]),
    });
    return { dir, config };
}
function save(dir, name, object) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(object), { mode: 0o600 });
    return file;
}
async function listen(t, server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    return server.address().port;
}
async function unusedPort() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function start(t, file, port, client = false) {
    const readyFile = path.join(path.dirname(file), 'mihomo.ready');
    // Mihomo opens listeners before loading providers and leaving its suspended state.
    // Its post-up hook runs after ApplyConfig, so a TCP accept alone is not readiness.
    const readyCommand = "touch '" + readyFile.replaceAll("'", "'\\''") + "'";
    const child = spawn(client ? mihomo : binary,
        client ? ['-d', path.dirname(file), '-f', file, '-post-up', readyCommand] : ['run', '-config', file],
        { stdio: 'ignore' });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exit = once(child, 'exit');
            child.kill('SIGTERM');
            await exit;
        }
    });
    for (let i = 0; i < 100; i++) {
        assert.equal(child.exitCode, null, 'Proxy core exited during startup');
        if (client) {
            if (fs.existsSync(readyFile)) return child;
            await delay(25);
            continue;
        }
        const connected = await new Promise(resolve => {
            const socket = net.connect({ host: '127.0.0.1', port });
            socket.once('connect', () => { socket.destroy(); resolve(true); });
            socket.once('error', () => resolve(false));
        });
        if (connected) return child;
        await delay(25);
    }
    throw new Error('Proxy core did not open its listener');
}
function clientConfig(config, serverPort, socksPort, id = config.clients[0].id) {
    return {
        log: { loglevel: 'none' },
        inbounds: [{ listen: '127.0.0.1', port: socksPort, protocol: 'socks', settings: { auth: 'noauth' } }],
        outbounds: [{ protocol: 'vless', settings: {
            vnext: [{ address: '127.0.0.1', port: serverPort, users: [{ id, encryption: 'none', flow: 'xtls-rprx-vision' }] }],
        }, streamSettings: { network: 'raw', security: 'reality', realitySettings: {
            fingerprint: 'chrome', serverName: config.serverName, password: config.publicKey, shortId: config.shortId,
        } } }],
    };
}
function request(socksPort, targetHost, targetPort) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port: socksPort });
        let stage = 0;
        let buffer = Buffer.alloc(0);
        socket.setTimeout(2500, () => socket.destroy(new Error('proxy request timed out')));
        socket.on('error', reject);
        socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])));
        socket.on('data', data => {
            buffer = Buffer.concat([buffer, data]);
            if (stage === 0 && buffer.length >= 2) {
                assert.deepEqual(buffer.subarray(0, 2), Buffer.from([5, 0]));
                buffer = buffer.subarray(2);
                const host = Buffer.from(targetHost);
                const port = Buffer.alloc(2); port.writeUInt16BE(targetPort);
                socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, port]));
                stage = 1;
            }
            if (stage === 1 && buffer.length >= 10) {
                if (buffer[1] !== 0) { socket.destroy(new Error('SOCKS request rejected')); return; }
                const length = buffer[3] === 4 ? 22 : 10;
                if (buffer.length < length) return;
                buffer = buffer.subarray(length);
                stage = 2;
                socket.write('GET / HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n');
            }
            if (stage === 2 && buffer.includes(Buffer.from('fixture-ok'))) {
                resolve(buffer.toString());
                socket.destroy();
            }
        });
        socket.on('end', () => {
            const response = buffer.toString();
            socket.destroy();
            if (response.includes('fixture-ok')) resolve(response);
            else reject(new Error(`no authenticated response (SOCKS stage ${stage}, bytes ${buffer.length})`));
        });
    });
}

test('the pinned Xray core accepts the generated production configuration', { skip: !binary }, t => {
    const { dir, config } = fixture(t);
    const file = save(dir, 'server.json', buildServerConfig(config));
    const result = spawnSync(binary, ['run', '-test', '-config', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('Mihomo accepts the generated client configuration', { skip: !mihomo }, t => {
    const { dir, config } = fixture(t);
    const file = save(dir, 'mihomo.yaml', buildClientConfig(config, config.clients[0]));
    const result = spawnSync(mihomo, ['-t', '-d', dir, '-f', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('REALITY authenticates traffic, rejects unknown UUIDs and blocks local destinations', { skip: !binary, timeout: 25000 }, async t => {
    const { dir, config } = fixture(t);
    const cert = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
        '-days', '1', '-subj', `/CN=${config.serverName}`], { stdio: 'ignore' });
    assert.equal(cert.status, 0, 'openssl certificate generation failed');
    const sockets = new Set();
    const target = tls.createServer({
        key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')),
        minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', ALPNProtocols: ['h2', 'http/1.1'], ecdhCurve: 'X25519',
    }, socket => { socket.on('error', () => {}); });
    target.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    t.after(() => { for (const socket of sockets) socket.destroy(); });
    const tlsPort = await listen(t, target);
    const echo = http.createServer((req, res) => res.end('fixture-ok'));
    const echoPort = await listen(t, echo);
    let blockedHits = 0;
    const blocked = http.createServer((req, res) => { blockedHits++; res.end('fixture-ok'); });
    const blockedPort = await listen(t, blocked);
    const serverPort = await unusedPort();
    const server = buildServerConfig(config);
    server.inbounds[0].listen = '127.0.0.1';
    server.inbounds[0].port = serverPort;
    server.inbounds[0].streamSettings.realitySettings.target = `127.0.0.1:${tlsPort}`;
    // Test-only exception permits exactly one local echo service. Production has no allow rules.
    server.outbounds[0].settings.finalRules.unshift({ action: 'allow', ip: ['127.0.0.1/32'], port: String(echoPort) });
    const serverProcess = await start(t, save(dir, 'server.json', server), serverPort);
    const socksPort = await unusedPort();
    await start(t, save(dir, 'client.json', clientConfig(config, serverPort, socksPort)), socksPort);
    assert.match(await request(socksPort, '127.0.0.1', echoPort), /fixture-ok/);
    await assert.rejects(request(socksPort, '127.0.0.1', blockedPort));
    await assert.rejects(request(socksPort, '::ffff:127.0.0.1', blockedPort));
    await assert.rejects(request(socksPort, 'localhost', blockedPort));
    assert.equal(blockedHits, 0);
    const badSocksPort = await unusedPort();
    await start(t, save(dir, 'bad-client.json', clientConfig(config, serverPort, badSocksPort, crypto.randomUUID())), badSocksPort);
    await assert.rejects(request(badSocksPort, '127.0.0.1', echoPort));
    const malformed = net.connect({ host: '127.0.0.1', port: serverPort });
    malformed.on('error', () => {});
    malformed.end(Buffer.alloc(0));
    await delay(50);
    assert.equal(serverProcess.exitCode, null);
    assert.match(await request(socksPort, '127.0.0.1', echoPort), /fixture-ok/);
    if (mihomo) {
        const mixedPort = await unusedPort();
        const client = buildClientConfig({ ...config, serverAddress: '127.0.0.1', serverPort }, config.clients[0]);
        client['mixed-port'] = mixedPort;
        client.dns.listen = `127.0.0.1:${await unusedPort()}`;
        await start(t, save(dir, 'mihomo.yaml', client), mixedPort, true);
        assert.match(await request(mixedPort, '127.0.0.1', echoPort).catch(error => {
            throw new Error(`Mihomo REALITY request failed: ${error.message}`, { cause: error });
        }), /fixture-ok/);
    }
});
