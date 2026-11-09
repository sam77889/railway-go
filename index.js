// ============================================================
// Railway Cloudflare Tunnel VLESS-WS 轻量节点 — Node.js 服务端（双隧道版）
//
// 端点：
//   GET /              健康检查（Railway healthcheck）
//   GET /{uuid}        双节点 vless:// 链接（每行一条）
//   GET /{uuid}/clash  完整 Clash YAML 配置（Mihomo/Clash Meta）
//   WS                 VLESS 协议处理
//
// 域名来源：
//   固定隧道: 环境变量 CLOUDFLARE_TUNNEL_DOMAIN 或 /tmp/cloudflare_tunnel_domain_fixed
//   临时隧道: /tmp/cloudflare_tunnel_domain_tmp（start.sh 写入）
// ============================================================

const os = require('os');
const fs = require('fs');
const http = require('http');
const net = require('net');
const dns = require('dns');
const dgram = require('dgram');
const path = require('path');
const { createWebSocketStream, Server: WSServer } = require('ws');
const { readConfig, createGateway, checkBackend } = require('./railway-xray/gateway');
const { startBackend } = require('./railway-xray/backend');

// ===== 出站 DNS 缓存 =====
// 每条新连接都做一次域名解析会叠加 10-50ms 延迟；缓存 5 分钟内同一域名零解析开销
const DNS_TTL = 5 * 60 * 1000;
const dnsCache = new Map(); // host -> { address, family, expires }
function cachedLookup(host, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const hit = dnsCache.get(host);
    if (hit && hit.expires > Date.now()) {
        if (opts.all) return process.nextTick(() => cb(null, [{ address: hit.address, family: hit.family }]));
        return process.nextTick(() => cb(null, hit.address, hit.family));
    }
    dns.lookup(host, { all: true }, (err, addrs) => {
        if (err) return cb(err);
        const pick = addrs.find(a => a.family === 4) || addrs[0];
        dnsCache.set(host, { address: pick.address, family: pick.family, expires: Date.now() + DNS_TTL });
        if (opts.all) return cb(null, [{ address: pick.address, family: pick.family }]);
        cb(null, pick.address, pick.family);
    });
}

// ===== 配置 =====
const NAME = process.env.NAME || 'cloudflare_tunnel';
const PORT = process.env.PORT || 8080;
const PROXY_BACKEND = process.env.PROXY_BACKEND || 'both';
if (!['both', 'node', 'railway-xray'].includes(PROXY_BACKEND)) {
    throw new Error('PROXY_BACKEND must be both, node or railway-xray');
}
const nodeEnabled = PROXY_BACKEND !== 'railway-xray';
const rustConfig = PROXY_BACKEND !== 'node' ? readConfig({
    ...process.env, PORT: String(PORT), DOMAIN: '', RAILWAY_PUBLIC_DOMAIN: '',
}) : null;
const uuid = rustConfig ? rustConfig.uuid : process.env.uuid || '79411d85-b0dc-4cd2-b46c-01789a18c650';
const STATE_DIR = process.env.TUNNEL_STATE_DIR || '/tmp';
// CF_IP 支持逗号分隔的多个优选 IP（每个 IP 生成一个节点）
const CF_IPS = (process.env.CF_IP || '').split(',').map(s => s.trim()).filter(Boolean);
const variants = [
    ...(nodeEnabled ? [{ protocol: 'vless', backend: 'node', wsPath: '/', label: '', linkPrefix: 'Vl' }] : []),
    ...(rustConfig ? [
        { protocol: 'vless', backend: 'railway-xray', wsPath: nodeEnabled ? '/vless' : '/', label: nodeEnabled ? 'Xray-' : '', linkPrefix: nodeEnabled ? 'Xray-Vl' : 'Vl' },
        { protocol: 'trojan', backend: 'railway-xray', wsPath: '/trojan', label: 'Trojan-', linkPrefix: 'Tr' },
    ] : []),
];

// ===== 域名获取 =====
function getFixedDomain() {
    if (process.env.CLOUDFLARE_TUNNEL_DOMAIN) return process.env.CLOUDFLARE_TUNNEL_DOMAIN;
    try { return fs.readFileSync(path.join(STATE_DIR, 'cloudflare_tunnel_domain_fixed'), 'utf8').trim(); } catch { return null; }
}

function getTmpDomain() {
    try { return fs.readFileSync(path.join(STATE_DIR, 'cloudflare_tunnel_domain_tmp'), 'utf8').trim(); } catch { return null; }
}

// ===== VLESS 链接生成 =====
// addr 为空时使用隧道域名作为连接地址
function buildVlessLink(domain, tag, addr, variant) {
    return `vless://${uuid}@${addr || domain}:443?encryption=none&security=tls&sni=${domain}&fp=chrome&type=ws&host=${domain}&path=${encodeURIComponent(variant.wsPath)}#${variant.linkPrefix}-${tag}-${NAME}`;
}

function buildTrojanLink(domain, tag, addr) {
    const server = addr || domain;
    const host = net.isIP(server) === 6 ? `[${server}]` : server;
    const link = new URL(`trojan://${encodeURIComponent(rustConfig.trojanPassword)}@${host}:443`);
    for (const [key, value] of Object.entries({
        security: 'tls', sni: domain, fp: 'chrome', type: 'ws', host: domain, path: '/trojan',
    })) link.searchParams.set(key, value);
    link.hash = `Tr-${tag}-${NAME}`;
    return link.href;
}

function getAllLinks() {
    const links = [];
    const fixed = getFixedDomain();
    const tmp = getTmpDomain();
    // 每个后端保留隧道域名节点，再追加各优选 IP，节点名称互不重复。
    for (const variant of variants) {
        const build = (domain, tag, addr) => variant.protocol === 'trojan'
            ? buildTrojanLink(domain, tag, addr)
            : buildVlessLink(domain, tag, addr, variant);
        for (const [domain, tag] of [[fixed, 'fixed'], [tmp, 'tmp']]) {
            if (!domain) continue;
            links.push(build(domain, tag, null));
            CF_IPS.forEach((a, i) => links.push(build(domain, `${tag}-${i + 1}`, a)));
        }
    }
    return links;
}

// ===== Clash YAML 生成 =====
function buildClashProxy(name, domain, addr, variant) {
    const server = addr || domain;
    const protocol = variant.protocol;
    return [
        `  - name: ${name}`,
        `    type: ${protocol}`,
        `    server: ${server}`,
        `    port: 443`,
        protocol === 'trojan' ? `    password: ${JSON.stringify(rustConfig.trojanPassword)}` : `    uuid: ${uuid}`,
        `    network: ws`,
        `    tls: true`,
        `    udp: ${variant.backend === 'node'}`,
        `    servername: ${domain}`,
        `    client-fingerprint: chrome`,
        `    ws-opts:`,
        `      path: ${JSON.stringify(variant.wsPath)}`,
        `      headers:`,
        `        Host: ${domain}`,
    ].join('\n');
}

function buildClashYaml() {
    const fixed = getFixedDomain();
    const tmp = getTmpDomain();
    const proxies = [];
    const domainNames = []; // 隧道域名节点：进 Proxy-Select / Auto-Fallback
    const cfIpNames = [];   // 优选 IP 节点：仅进独立代理组 cf-ip

    for (const [domain, label] of [[fixed, 'Fixed'], [tmp, 'Tmp']]) {
        if (!domain) continue;
        for (const variant of variants) {
            const baseName = `Cloudflare-Tunnel-${variant.label}${label}`;
            proxies.push(buildClashProxy(baseName, domain, null, variant));
            domainNames.push(baseName);
            CF_IPS.forEach((address, i) => {
                const name = `${baseName}-${i + 1}`;
                proxies.push(buildClashProxy(name, domain, address, variant));
                cfIpNames.push(name);
            });
        }
    }

    if (proxies.length === 0) return null;

    const proxyList = domainNames.map(n => `      - ${n}`).join('\n');
    // Proxy-Select 可选项：Auto-Fallback + 域名节点 + cf-ip 组（组引用，其成员不直接进入主组）
    const selectItems = ['Auto-Fallback', ...domainNames];
    if (cfIpNames.length > 0) selectItems.push('cf-ip');
    const selectList = selectItems.map(n => `      - ${n}`).join('\n');
    // 优选 IP 独立代理组：url-test 自动选择延迟最低节点，不进 Proxy-Select / Auto-Fallback
    const cfIpGroup = cfIpNames.length > 0
        ? `\n\n  - name: cf-ip\n    type: url-test\n    url: https://www.gstatic.com/generate_204\n    interval: 300\n    tolerance: 50\n    lazy: false\n    proxies:\n${cfIpNames.map(n => `      - ${n}`).join('\n')}`
        : '';

    return `# Railway Cloudflare Tunnel VLESS-WS 双隧道 — Clash Meta / Mihomo 配置
# 自动生成，请勿手动编辑
# 订阅地址: /{uuid}/clash

mixed-port: 7890
allow-lan: true
mode: rule
log-level: info
unified-delay: true
tcp-concurrent: true
find-process-mode: strict
profile:
  store-selected: true
  store-fake-ip: true

dns:
  enable: true
  listen: "0.0.0.0:1053"
  ipv6: false
  prefer-h3: false
  respect-rules: true
  use-system-hosts: true
  cache-algorithm: "arc"
  enhanced-mode: "fake-ip"
  fake-ip-range: "198.18.0.1/16"
  fake-ip-filter:
    - "+.argotunnel.com"
    - "+.lan"
    - "+.local"
    - "+.msftconnecttest.com"
    - "+.msftncsi.com"
    - "localhost.ptlogin2.qq.com"
    - "localhost.sec.qq.com"
    - "+.in-addr.arpa"
    - "+.ip6.arpa"
    - "time.*.com"
    - "time.*.gov"
    - "pool.ntp.org"
    - "localhost.work.weixin.qq.com"
  default-nameserver: ["223.5.5.5", "119.29.29.29"]
  nameserver:
    - "https://1.1.1.1/dns-query"
    - "https://8.8.8.8/dns-query"
  nameserver-policy:
    "geosite:cn":
      - "https://223.5.5.5/dns-query"
      - "https://doh.pub/dns-query"
    "+.cn":
      - "https://223.5.5.5/dns-query"
      - "https://doh.pub/dns-query"
  proxy-server-nameserver:
    - "https://223.5.5.5/dns-query"
    - "https://doh.pub/dns-query"

sniffer:
  enable: true
  force-dns-mapping: true
  parse-pure-ip: true
  sniff:
    HTTP:
      ports: [80, 8080-8880]
      override-destination: true
    TLS:
      ports: [443, 8443]
    QUIC:
      ports: [443, 8443]
  skip-domain:
    - "Mijia Cloud"
    - "+.push.apple.com"

proxies:
${proxies.join('\n\n')}

proxy-groups:
  - name: Proxy-Select
    type: select
    proxies:
${selectList}

  - name: Auto-Fallback
    type: fallback
    url: https://www.gstatic.com/generate_204
    interval: 60
    timeout: 3000
    max-failed-times: 2
    lazy: false
    proxies:
${proxyList}${cfIpGroup}

rules:
  - PROCESS-NAME,cloudflared,DIRECT
  - DOMAIN-SUFFIX,argotunnel.com,DIRECT
  - DOMAIN-SUFFIX,chinamobile.com,DIRECT
  - DOMAIN-SUFFIX,deepseek.com,DIRECT
  - DOMAIN-SUFFIX,baidu.com,DIRECT
  - DOMAIN-SUFFIX,qq.com,DIRECT
  - DOMAIN-SUFFIX,taobao.com,DIRECT
  - DOMAIN-SUFFIX,tmall.com,DIRECT
  - DOMAIN-SUFFIX,jd.com,DIRECT
  - DOMAIN-SUFFIX,tencent.com,DIRECT
  - DOMAIN-SUFFIX,alipay.com,DIRECT
  - DOMAIN-SUFFIX,aliyun.com,DIRECT
  - DOMAIN-SUFFIX,163.com,DIRECT
  - DOMAIN-SUFFIX,zhihu.com,DIRECT
  - DOMAIN-SUFFIX,bilibili.com,DIRECT
  - DOMAIN-SUFFIX,douyin.com,DIRECT
  - DOMAIN-SUFFIX,xiaohongshu.com,DIRECT
  - DOMAIN-SUFFIX,xiaomi.com,DIRECT
  - DOMAIN-SUFFIX,huawei.com,DIRECT
  - DOMAIN-SUFFIX,weibo.com,DIRECT
  - DOMAIN-SUFFIX,douban.com,DIRECT
  - DOMAIN-SUFFIX,youku.com,DIRECT
  - DOMAIN-SUFFIX,iqiyi.com,DIRECT
  - DOMAIN-SUFFIX,meituan.com,DIRECT
  - DOMAIN-SUFFIX,dianping.com,DIRECT
  - DOMAIN-SUFFIX,ctrip.com,DIRECT
  - DOMAIN-SUFFIX,12306.cn,DIRECT
  - DOMAIN-SUFFIX,gov.cn,DIRECT
  - DOMAIN-SUFFIX,edu.cn,DIRECT
  - DOMAIN-SUFFIX,cn,DIRECT
  - GEOSITE,cn,DIRECT
  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve
  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve
  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
  - IP-CIDR,127.0.0.0/8,DIRECT,no-resolve
  - IP-CIDR,224.0.0.0/4,DIRECT,no-resolve
  - GEOIP,CN,DIRECT
  - MATCH,Proxy-Select
`;
}

// ===== HTTP 服务 =====
// noDelay: 禁用 Nagle，代理小包流量不受 40ms 合并延迟影响
const requestHandler = (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // 健康检查
    if (req.url === '/') {
        if (rustConfig) {
            checkBackend(rustConfig, ready => {
                if (res.destroyed) return;
                res.writeHead(ready ? 200 : 503, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(ready ? 'Cloudflare Tunnel Railway Xray 网关运行中\n' : 'Railway Xray 后端尚未就绪\n');
            });
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('🟢 Cloudflare Tunnel VLESS-WS 双隧道节点运行中\n');
        return;
    }

    // 双节点 vless:// 链接
    if (req.url === `/${uuid}`) {
        const links = getAllLinks();
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        if (links.length > 0) {
            res.end(links.join('\n') + '\n');
        } else {
            res.end('⏳ Cloudflare Tunnel 隧道域名尚未就绪，请稍后刷新\n');
        }
        return;
    }

    // Clash YAML 订阅
    if (req.url === `/${uuid}/clash`) {
        const yaml = buildClashYaml();
        if (yaml) {
            res.writeHead(200, {
                'Content-Type': 'text/yaml; charset=utf-8',
                'Content-Disposition': 'attachment; filename=railway',
                'Profile-Title': 'railway',
                'Profile-Update-Interval': '6',
            });
            res.end(yaml);
        } else {
            res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('⏳ Cloudflare Tunnel 隧道域名尚未就绪，请稍后刷新\n');
        }
        return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
};

const gateway = rustConfig ? createGateway(rustConfig, {
    requestHandler,
    vlessRoot: !nodeEnabled,
    rootUpgrade: nodeEnabled ? (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    } : undefined,
}) : null;
const server = gateway ? gateway.server : http.createServer({ noDelay: true }, requestHandler);
let backend;
let stopping = false;

async function shutdown(code) {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(code), 6000);
    try {
        if (wss) for (const client of wss.clients) client.terminate();
        await Promise.all([
            gateway ? gateway.close() : new Promise(resolve => {
                server.closeAllConnections();
                server.close(resolve);
            }),
            wss ? new Promise(resolve => wss.close(resolve)) : Promise.resolve(),
            backend ? backend.stop() : Promise.resolve(),
        ]);
        clearTimeout(deadline);
        process.exit(code);
    } catch {
        console.error('[index.js] 关闭服务失败');
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
server.once('error', error => {
    console.error(`[index.js] 服务异常: ${error.code || 'server error'}`);
    shutdown(1);
});
if (rustConfig) {
    backend = startBackend(rustConfig, error => {
        console.error(`[index.js] ${error.message}`);
        shutdown(1);
    });
}

server.listen(PORT, () => {
    console.log(`[index.js] HTTP/WS 服务已启动，端口: ${PORT}`);
});

// ===== WebSocket VLESS 协议处理 =====
// perMessageDeflate 关闭：VLESS 帧是已加密的二进制，压缩只耗 CPU 不省带宽
// maxPayload 收紧：VLESS 单帧无需 100MB 默认值，降低恶意大帧的内存占用
const wss = nodeEnabled ? new WSServer({
    ...(gateway ? { noServer: true } : { server }),
    perMessageDeflate: false,
    maxPayload: 16 * 1024 * 1024,
}) : null;
const uuidkey = uuid.replace(/-/g, '');

if (wss) wss.on('connection', ws => {
    ws.once('message', msg => {
        const [VERSION] = msg;
        const id = msg.slice(1, 17);

        // UUID 校验
        if (!id.every((v, i) => v == parseInt(uuidkey.substr(i * 2, 2), 16))) return;

        const addonLen = msg.slice(17, 18).readUInt8();
        const cmd = msg.slice(18 + addonLen, 19 + addonLen).readUInt8(); // 1=TCP, 2=UDP
        let i = 19 + addonLen;
        const port = msg.slice(i, i += 2).readUInt16BE(0);
        const ATYP = msg.slice(i, i += 1).readUInt8();

        const host = ATYP == 1
            ? msg.slice(i, i += 4).join('.')
            : (ATYP == 2
                ? new TextDecoder().decode(
                    msg.slice(i + 1, i += 1 + msg.slice(i, i + 1).readUInt8()))
                : (ATYP == 3
                    ? msg.slice(i, i += 16)
                        .reduce((s, b, idx, a) => (idx % 2 ? s.concat(a.slice(idx - 1, idx + 1)) : s), [])
                        .map(b => b.readUInt16BE(0).toString(16)).join(':')
                    : ''));

        // VLESS 响应头 [VERSION, 0]：TCP/UDP 通用，客户端都会先消费这 2 字节
        ws.send(new Uint8Array([VERSION, 0]));

        if (cmd === 2) {
            // ===== VLESS UDP relay =====
            // 线路格式（与 edgetunnel / Xray 一致）：目标地址取自 VLESS 头；
            // 每个 UDP 数据报帧 = [2 字节大端长度][payload]，可跨 WebSocket message，需流式缓冲。
            const udp = dgram.createSocket(ATYP === 3 ? 'udp6' : 'udp4');
            udp.on('error', () => { });

            // 空闲超时：60s 无收发则关闭，避免 UDP socket 泄漏
            let idle = null;
            const poke = () => {
                if (idle) clearTimeout(idle);
                idle = setTimeout(() => { try { ws.close(); } catch { } }, 60000);
            };

            // 服务端 -> 客户端：收到的 UDP 报文按 [2 字节长度][payload] 帧回传
            udp.on('message', buf => {
                if (ws.readyState !== ws.OPEN) return;
                const hdr = Buffer.alloc(2);
                hdr.writeUInt16BE(buf.length, 0);
                ws.send(Buffer.concat([hdr, buf]));
            });
            udp.on('message', poke);

            // 客户端 -> 服务端：从 WS 流中解析 [2 字节长度][payload] 帧，逐个 udp.send 到目标
            // 域名目标经 DNS 缓存解析一次后直发 IP；IP 目标零开销
            const EMPTY = Buffer.alloc(0);
            let targetIp = net.isIP(host) ? host : null;
            const sendUdp = payload => {
                if (targetIp) { try { udp.send(payload, port, targetIp); } catch { } return; }
                cachedLookup(host, {}, (err, ip) => {
                    if (err) return;
                    targetIp = ip;
                    try { udp.send(payload, port, ip); } catch { }
                });
            };
            let leftover = msg.slice(i);
            const processFrames = chunk => {
                // 快速路径：无粘包残留时直接解析 chunk，省一次 Buffer.concat 全量拷贝
                let buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
                let off = 0;
                while (buf.length - off >= 2) {
                    const len = buf.readUInt16BE(off);
                    if (buf.length - off < 2 + len) break; // 帧不完整，等下一截
                    sendUdp(buf.slice(off + 2, off + 2 + len));
                    poke();
                    off += 2 + len;
                }
                leftover = off === buf.length ? EMPTY : buf.slice(off);
            };

            poke();
            processFrames(Buffer.alloc(0));
            ws.on('message', data => processFrames(Buffer.from(data)));

            const cleanup = () => {
                if (idle) clearTimeout(idle);
                try { udp.close(); } catch { }
            };
            ws.on('close', cleanup);
            ws.on('error', cleanup);
            udp.on('close', () => { try { ws.close(); } catch { } });
        } else if (cmd === 3) {
            // ===== VLESS XUDP-over-Mux（cmd=0x03, v1.mux.cool:666）=====
            // Mihomo 默认用此模式发 UDP（full-cone NAT）。帧格式见 sing-vmess/xudp.go：
            //   [2帧长][0][0][frametype][option][network][addr=port+ATYP+addr][globalID?(New)][2数据长][数据]
            //   frametype: 1=New 2=Keep 3=End | option: bit0=OptionData bit1=OptionError | network: 2=UDP
            // 每包自带目标地址；服务端按目标地址复用 UDP socket，回向用 Keep 帧封装。
            const sockets = new Map(); // "host:port" -> dgram socket
            let idle = null;
            const poke = () => {
                if (idle) clearTimeout(idle);
                idle = setTimeout(() => { try { ws.close(); } catch { } }, 60000);
            };
            const closeAll = () => {
                for (const e of sockets.values()) {
                    e.closed = true;
                    if (e.s) { try { e.s.close(); } catch { } }
                }
                sockets.clear();
            };

            // 解析 [port(2)][ATYP(1)][addr]，与 VLESS 地址格式一致（ATYP: 1=IPv4 2=域名 3=IPv6）
            const parseAddr = (buf, off) => {
                const port = buf.readUInt16BE(off); off += 2;
                const atyp = buf.readUInt8(off); off += 1;
                let host;
                if (atyp === 1) { host = buf.slice(off, off + 4).join('.'); off += 4; }
                else if (atyp === 2) { const len = buf.readUInt8(off); off += 1; host = buf.slice(off, off + len).toString(); off += len; }
                else if (atyp === 3) {
                    const p = []; for (let k = 0; k < 16; k += 2) p.push(buf.readUInt16BE(off + k).toString(16));
                    host = p.join(':'); off += 16;
                } else host = '';
                return { host, port, atyp, off };
            };

            // 回向 Keep 帧：[2帧长=5+addrLen][0][0][2 Keep][1 OptionData][2 NetworkUDP][addr][2数据长][数据]
            const sendKeep = (addrBuf, payload) => {
                if (ws.readyState !== ws.OPEN) return;
                const frameLen = 5 + addrBuf.length;
                const hdr = Buffer.alloc(2 + frameLen + 2);
                hdr.writeUInt16BE(frameLen, 0);
                hdr[2] = 0; hdr[3] = 0; hdr[4] = 2; hdr[5] = 1; hdr[6] = 2;
                addrBuf.copy(hdr, 7);
                hdr.writeUInt16BE(payload.length, 2 + frameLen);
                ws.send(Buffer.concat([hdr, payload]));
            };

            // sockets 值为 { s, ip, addrBuf, queue, closed }：s/ip 在 DNS 解析完成后填充，
            // 解析期间到达的帧暂存 queue；域名目标同样走 DNS 缓存
            const getSocket = (host, port, atyp, addrBuf) => {
                const key = host + ':' + port;
                let e = sockets.get(key);
                if (e) return e;
                e = { s: null, ip: null, addrBuf, queue: [], closed: false };
                sockets.set(key, e);
                cachedLookup(host, {}, (err, ip) => {
                    if (err || e.closed) { if (!e.closed) sockets.delete(key); return; }
                    const s = dgram.createSocket(atyp === 3 ? 'udp6' : 'udp4');
                    s.on('error', () => { });
                    s.on('message', buf => { sendKeep(addrBuf, buf); poke(); });
                    e.s = s;
                    e.ip = ip;
                    if (e.queue.length) {
                        e.queue.forEach(p => { try { s.send(p, port, ip); } catch { } });
                        e.queue.length = 0;
                    }
                });
                return e;
            };

            // 流式解析 XUDP 帧（可跨 WebSocket message）
            const EMPTY = Buffer.alloc(0);
            let leftover = msg.slice(i);
            const processFrames = chunk => {
                // 快速路径：无粘包残留时直接解析 chunk，省一次 Buffer.concat 全量拷贝
                let buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
                let off = 0;
                while (buf.length - off >= 2) {
                    const frameLen = buf.readUInt16BE(off);
                    if (buf.length - off < 2 + frameLen) break;                 // 帧头块不全
                    const frametype = buf.readUInt8(off + 4);
                    const option = buf.readUInt8(off + 5);
                    if (frametype === 3) { try { ws.close(); } catch { } return; } // End
                    const hasData = (option & 1) === 1;
                    let frameTotal = 2 + frameLen;
                    if (hasData) {
                        if (buf.length - off < 2 + frameLen + 2) break;         // 数据长字段不全
                        const payloadLen = buf.readUInt16BE(off + 2 + frameLen);
                        if (buf.length - off < 2 + frameLen + 2 + payloadLen) break; // 数据不全
                        const a = parseAddr(buf, off + 7);
                        const addrBuf = buf.slice(off + 7, a.off);
                        const payload = buf.slice(off + 2 + frameLen + 2, off + 2 + frameLen + 2 + payloadLen);
                        if (a.host) {
                            const e = getSocket(a.host, a.port, a.atyp, addrBuf);
                            if (e.s) { try { e.s.send(payload, a.port, e.ip); } catch { } }
                            else e.queue.push(payload);
                            poke();
                        }
                        frameTotal = 2 + frameLen + 2 + payloadLen;
                    }
                    off += frameTotal;
                }
                leftover = off === buf.length ? EMPTY : buf.slice(off);
            };

            poke();
            processFrames(Buffer.alloc(0));
            ws.on('message', data => processFrames(Buffer.from(data)));
            ws.on('close', () => { if (idle) clearTimeout(idle); closeAll(); });
            ws.on('error', () => { if (idle) clearTimeout(idle); closeAll(); });
        } else {
            // ===== VLESS TCP relay =====
            const socket = net.connect({ host, port, lookup: cachedLookup });
            socket.setNoDelay(true); // 禁用 Nagle，避免代理小包流量叠加 40ms 合并延迟
            socket.on('connect', () => {
                socket.write(msg.slice(i));
                const duplex = createWebSocketStream(ws);
                duplex.on('error', () => { });
                duplex.pipe(socket).on('error', () => { }).pipe(duplex);
            });
            // 任一侧断开都彻底清理，防止僵尸连接累积占用内存/句柄
            const cleanup = () => { socket.destroy(); try { ws.close(); } catch { } };
            socket.on('error', cleanup);
            socket.on('close', () => { try { ws.close(); } catch { } });
            ws.on('close', () => socket.destroy());
            ws.on('error', () => socket.destroy());
        }
    }).on('error', () => { });
});
