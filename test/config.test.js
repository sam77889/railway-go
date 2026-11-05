const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

function environment() {
    const { privateKey } = crypto.generateKeyPairSync('x25519');
    return {
        SERVER_ADDRESS: '203.0.113.10',
        REALITY_SERVER_NAME: 'www.example.com',
        REALITY_PRIVATE_KEY: privateKey.export({ format: 'jwk' }).d,
        REALITY_SHORT_ID: '0123456789abcdef',
        VLESS_CLIENTS: JSON.stringify([
            { name: 'phone', id: crypto.randomUUID() },
            { name: 'laptop', id: crypto.randomUUID() },
        ]),
    };
}

test('requires explicit credentials and rejects malformed inputs without echoing them', () => {
    const { readConfig } = require('../lib/config');
    for (const key of Object.keys(environment())) {
        const env = environment();
        delete env[key];
        assert.throws(() => readConfig(env), new RegExp(key));
    }
    const invalid = {
        SERVER_ADDRESS: ['https://example.com/', 'host:443', 'example.com/path', 'bad host'],
        REALITY_SERVER_NAME: ['127.0.0.1', 'localhost', 'foo.local', 'a/b', '*.example.com'],
        REALITY_PRIVATE_KEY: ['leaked-secret', 'A'.repeat(43), 'x'.repeat(44)],
        REALITY_SHORT_ID: ['', '01', 'g'.repeat(16)],
        SERVER_PORT: ['0', '65536', '443x', '3.5'],
        VLESS_CLIENTS: ['secret-not-json', '{}', '[]', '[null]', '[{"name":"../escape","id":"bad"}]'],
    };
    for (const [key, values] of Object.entries(invalid)) {
        for (const value of values) {
            assert.throws(() => readConfig({ ...environment(), [key]: value }), error => {
                assert.match(error.message, new RegExp(key));
                if (value.length > 10) assert.ok(!error.message.includes(value));
                return true;
            });
        }
    }
});

test('rejects duplicate device names and UUIDs, including uppercase UUID equivalents', () => {
    const { readConfig } = require('../lib/config');
    const env = environment();
    const clients = JSON.parse(env.VLESS_CLIENTS);
    clients[1].name = clients[0].name;
    assert.throws(() => readConfig({ ...env, VLESS_CLIENTS: JSON.stringify(clients) }), /VLESS_CLIENTS/);
    clients[1].name = 'laptop';
    clients[1].id = clients[0].id.toUpperCase();
    assert.throws(() => readConfig({ ...env, VLESS_CLIENTS: JSON.stringify(clients) }), /VLESS_CLIENTS/);
});

test('rejects client strategy names and case-insensitive filename collisions', () => {
    const { readConfig } = require('../lib/config');
    for (const name of ['PROXY', 'DIRECT', 'REJECT', 'GLOBAL', 'reject-drop']) {
        const env = environment();
        const clients = JSON.parse(env.VLESS_CLIENTS);
        clients[0].name = name;
        assert.throws(() => readConfig({ ...env, VLESS_CLIENTS: JSON.stringify(clients) }), /VLESS_CLIENTS/);
    }
    const env = environment();
    const clients = JSON.parse(env.VLESS_CLIENTS);
    clients[1].name = clients[0].name.toUpperCase();
    assert.throws(() => readConfig({ ...env, VLESS_CLIENTS: JSON.stringify(clients) }), /VLESS_CLIENTS/);
});

test('derives the correct REALITY public key and generates a private server config', () => {
    const { readConfig, buildServerConfig } = require('../lib/config');
    const env = environment();
    const config = readConfig(env);
    const privateKey = crypto.createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(env.REALITY_PRIVATE_KEY, 'base64url')]),
        format: 'der', type: 'pkcs8',
    });
    const derived = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
    assert.equal(config.publicKey, derived);
    const server = buildServerConfig(config);
    assert.equal(server.inbounds.length, 1);
    assert.equal(server.inbounds[0].port, 8443);
    assert.equal(server.inbounds[0].streamSettings.security, 'reality');
    assert.equal(server.inbounds[0].streamSettings.network, 'raw');
    assert.equal(server.inbounds[0].settings.clients.length, 2);
    assert.ok(server.inbounds[0].settings.clients.every(c => c.flow === 'xtls-rprx-vision'));
    assert.equal(server.log.access, 'none');
    assert.equal(server.log.loglevel, 'none');
    const rules = server.outbounds[0].settings.finalRules;
    assert.ok(rules.some(r => r.action === 'block' && r.ip.includes('169.254.0.0/16')));
    assert.ok(rules.some(r => r.action === 'block' && r.ip.includes('127.0.0.0/8')));
    assert.ok(rules.some(r => r.action === 'block' && r.ip.includes('fc00::/7')));
});

test('exports only the selected device, with local listeners, proxy DNS and no direct fallback', () => {
    const { readConfig, buildClientConfig, buildVlessLink } = require('../lib/config');
    const env = environment();
    const config = readConfig(env);
    const [phone, laptop] = config.clients;
    const client = buildClientConfig(config, phone);
    const serialized = JSON.stringify(client);
    assert.ok(!serialized.includes(env.REALITY_PRIVATE_KEY));
    assert.ok(!serialized.includes(laptop.id));
    assert.equal(client['allow-lan'], false);
    assert.equal(client['bind-address'], '127.0.0.1');
    assert.equal(client.dns.listen, '127.0.0.1:1053');
    assert.equal(client.dns['respect-rules'], true);
    assert.ok(client.dns.nameserver.every(s => s.endsWith('#PROXY')));
    assert.ok(!serialized.includes('1.1.1.1'));
    assert.equal(client.proxies[0].uuid, phone.id);
    assert.equal(client.proxies[0]['reality-opts']['public-key'], config.publicKey);
    assert.equal(client.proxies[0]['reality-opts']['support-x25519mlkem768'], true);
    assert.deepEqual(client['proxy-groups'][0].proxies, [phone.name]);
    assert.ok(!serialized.includes('DIRECT'));
    const link = new URL(buildVlessLink(config, phone));
    assert.equal(link.username, phone.id);
    assert.equal(link.searchParams.get('security'), 'reality');
    assert.equal(link.searchParams.get('pbk'), config.publicKey);
    assert.equal(link.searchParams.get('flow'), 'xtls-rprx-vision');
    assert.ok(!link.href.includes(env.REALITY_PRIVATE_KEY));
    assert.ok(!link.href.includes(laptop.id));
});

test('formats IPv6 server addresses correctly in links', () => {
    const { readConfig, buildVlessLink } = require('../lib/config');
    const config = readConfig({ ...environment(), SERVER_ADDRESS: '2001:db8::1' });
    const link = new URL(buildVlessLink(config, config.clients[0]));
    assert.equal(link.hostname, '[2001:db8::1]');
});
