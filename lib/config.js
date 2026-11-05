const { createPrivateKey, createPublicKey } = require('node:crypto');
const { isIP } = require('node:net');

// Explicit ranges avoid downloading mutable geodata at startup.
const BLOCKED_IPS = [
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
    '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
    '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
    // Xray normalizes IPv4-mapped IPv6 to IPv4; mapped /96 CIDRs are invalid here.
    '224.0.0.0/4', '240.0.0.0/4', '::/128', '::1/128',
    '64:ff9b::/96', '64:ff9b:1::/48', '100::/64', '2001:db8::/32',
    'fc00::/7', 'fe80::/10', 'ff00::/8',
];
const DEVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESERVED_NAMES = new Set(['PROXY', 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']);

class ConfigError extends Error {}
function invalid(field, reason) {
    throw new ConfigError(`${field}: ${reason}`);
}

function isHostname(value) {
    return typeof value === 'string' && value.length <= 253 && value.includes('.') &&
        value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) &&
        !/\.(local|localhost|internal|lan|home)$/i.test(value) && !isIP(value);
}

function readConfig(env) {
    for (const field of ['SERVER_ADDRESS', 'REALITY_SERVER_NAME', 'REALITY_PRIVATE_KEY', 'REALITY_SHORT_ID', 'VLESS_CLIENTS']) {
        if (typeof env[field] !== 'string' || !env[field]) invalid(field, 'required');
    }
    if (!isIP(env.SERVER_ADDRESS) && !isHostname(env.SERVER_ADDRESS)) {
        invalid('SERVER_ADDRESS', 'expected an IP address or hostname without scheme, path or port');
    }
    if (!isHostname(env.REALITY_SERVER_NAME)) invalid('REALITY_SERVER_NAME', 'expected a public TLS hostname');
    const port = env.SERVER_PORT === undefined ? '443' : env.SERVER_PORT;
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) invalid('SERVER_PORT', 'expected 1..65535');
    if (!/^[0-9a-f]{16}$/i.test(env.REALITY_SHORT_ID)) invalid('REALITY_SHORT_ID', 'expected 16 hex characters');
    const rawKey = Buffer.from(env.REALITY_PRIVATE_KEY, 'base64url');
    if (rawKey.length !== 32 || rawKey.toString('base64url') !== env.REALITY_PRIVATE_KEY || rawKey.every(b => b === 0)) {
        invalid('REALITY_PRIVATE_KEY', 'expected a 32-byte base64url X25519 key');
    }
    const privateKey = createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), rawKey]),
        format: 'der', type: 'pkcs8',
    });
    const publicKey = createPublicKey(privateKey).export({ format: 'jwk' }).x;
    let clients;
    try { clients = JSON.parse(env.VLESS_CLIENTS); } catch { invalid('VLESS_CLIENTS', 'expected a JSON array'); }
    if (!Array.isArray(clients) || !clients.length) invalid('VLESS_CLIENTS', 'at least one device is required');
    const names = new Set();
    const ids = new Set();
    clients = clients.map(client => {
        if (!client || typeof client.name !== 'string' || !DEVICE_NAME.test(client.name) ||
            typeof client.id !== 'string' || !UUID.test(client.id)) {
            invalid('VLESS_CLIENTS', 'each device needs a safe name (1..32 characters) and UUID v4');
        }
        const id = client.id.toLowerCase();
        if (RESERVED_NAMES.has(client.name.toUpperCase())) invalid('VLESS_CLIENTS', 'device name conflicts with a client strategy');
        if (names.has(client.name.toLowerCase()) || ids.has(id)) invalid('VLESS_CLIENTS', 'device names and UUIDs must be unique');
        names.add(client.name.toLowerCase());
        ids.add(id);
        return { name: client.name, id };
    });
    return {
        serverAddress: env.SERVER_ADDRESS, serverPort: Number(port),
        serverName: env.REALITY_SERVER_NAME, privateKey: env.REALITY_PRIVATE_KEY,
        publicKey, shortId: env.REALITY_SHORT_ID.toLowerCase(), clients,
    };
}

function buildServerConfig(config) {
    return {
        log: { access: 'none', error: 'none', loglevel: 'none', dnsLog: false },
        inbounds: [{
            tag: 'vless-in', listen: '0.0.0.0', port: 8443, protocol: 'vless',
            settings: {
                clients: config.clients.map(c => ({ id: c.id, email: c.name, flow: 'xtls-rprx-vision' })),
                decryption: 'none',
            },
            streamSettings: {
                network: 'raw', security: 'reality',
                realitySettings: {
                    show: false, target: `${config.serverName}:443`, xver: 0,
                    serverNames: [config.serverName], privateKey: config.privateKey,
                    shortIds: [config.shortId],
                },
            },
        }],
        outbounds: [{
            tag: 'internet', protocol: 'freedom',
            settings: { finalRules: [{ action: 'block', ip: BLOCKED_IPS, blockDelay: '0' }] },
        }],
        policy: { levels: { '0': { handshake: 5, connIdle: 300, uplinkOnly: 2, downlinkOnly: 5 } } },
    };
}

function buildVlessLink(config, client) {
    const address = isIP(config.serverAddress) === 6 ? `[${config.serverAddress}]` : config.serverAddress;
    const query = new URLSearchParams({
        encryption: 'none', security: 'reality', type: 'tcp', flow: 'xtls-rprx-vision',
        sni: config.serverName, fp: 'chrome', pbk: config.publicKey, sid: config.shortId,
    });
    return `vless://${client.id}@${address}:${config.serverPort}?${query}#${encodeURIComponent(client.name)}`;
}

function buildClientConfig(config, client) {
    return {
        'mixed-port': 7890, 'allow-lan': false, 'bind-address': '127.0.0.1',
        mode: 'rule', 'log-level': 'silent', ipv6: false,
        dns: {
            enable: true, listen: '127.0.0.1:1053', ipv6: false,
            'enhanced-mode': 'fake-ip', 'fake-ip-range': '198.18.0.1/16',
            'respect-rules': true,
            'default-nameserver': ['https://223.5.5.5/dns-query'],
            'proxy-server-nameserver': ['https://223.5.5.5/dns-query'],
            nameserver: ['https://8.8.8.8/dns-query#PROXY', 'https://8.8.4.4/dns-query#PROXY'],
        },
        proxies: [{
            name: client.name, type: 'vless', server: config.serverAddress, port: config.serverPort,
            uuid: client.id, network: 'tcp', tls: true, udp: true,
            flow: 'xtls-rprx-vision', 'packet-encoding': 'xudp', servername: config.serverName,
            'client-fingerprint': 'chrome',
            'reality-opts': {
                'public-key': config.publicKey, 'short-id': config.shortId,
                'support-x25519mlkem768': true,
            },
        }],
        'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: [client.name] }],
        rules: ['MATCH,PROXY'],
    };
}

module.exports = { ConfigError, readConfig, buildServerConfig, buildClientConfig, buildVlessLink };
