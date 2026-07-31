// ============================================================
// Railway Argo VLESS-WS 轻量节点 — Node.js 服务端
//
// 基于 quick-deploy/index.js，适配 Argo 隧道：
// - 域名从 /tmp/argo_domain 动态读取（start.sh 写入）
// - 支持 CF 优选 IP（CF_IP 环境变量）
// - 健康检查保持 Railway 容器存活
// - 纯 Node.js 实现 VLESS 协议，无需 Xray/sing-box
// ============================================================

const os = require('os');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { createWebSocketStream } = require('ws');
const { Server: WSServer } = require('ws');

// ===== 配置 =====
const NAME = process.env.NAME || 'argo';
const PORT = process.env.PORT || 8080;
const uuid = process.env.uuid || '79411d85-b0dc-4cd2-b46c-01789a18c650';
const CF_IP = process.env.CF_IP || '';

// ===== 动态获取 Argo 域名 =====
function getArgoDomain() {
    // 优先：环境变量（固定隧道）
    if (process.env.ARGO_DOMAIN) return process.env.ARGO_DOMAIN;
    // 其次：start.sh 写入的文件（临时隧道）
    try {
        return fs.readFileSync('/tmp/argo_domain', 'utf8').trim();
    } catch {
        return null;
    }
}

// ===== 生成 VLESS 节点链接 =====
function buildVlessLink() {
    const domain = getArgoDomain();
    if (!domain) return null;
    const addr = CF_IP || domain;
    return `vless://${uuid}@${addr}:443?encryption=none&security=tls&sni=${domain}&fp=chrome&type=ws&host=${domain}&path=%2F#Vl-${NAME}`;
}

// ===== HTTP 服务 =====
const server = http.createServer((req, res) => {
    // 健康检查（Railway healthcheckPath 指向这里）
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('🟢 Argo VLESS-WS 节点运行中\n');
        return;
    }

    // 节点链接页
    if (req.url === `/${uuid}`) {
        const link = buildVlessLink();
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        if (link) {
            res.end(link + '\n');
        } else {
            res.end('⏳ Argo 隧道域名尚未就绪，请稍后刷新\n');
        }
        return;
    }

    // 其他路径返回 404
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
});

server.listen(PORT, () => {
    console.log(`[index.js] HTTP/WS 服务已启动，端口: ${PORT}`);
});

// ===== WebSocket VLESS 协议处理 =====
const wss = new WSServer({ server });
const uuidkey = uuid.replace(/-/g, '');

wss.on('connection', ws => {
    ws.once('message', msg => {
        const [VERSION] = msg;
        const id = msg.slice(1, 17);

        // UUID 校验
        if (!id.every((v, i) => v == parseInt(uuidkey.substr(i * 2, 2), 16))) return;

        let i = msg.slice(17, 18).readUInt8() + 19;
        const port = msg.slice(i, i += 2).readUInt16BE(0);
        const ATYP = msg.slice(i, i += 1).readUInt8();

        // 解析目标地址
        const host = ATYP == 1
            ? msg.slice(i, i += 4).join('.')                                          // IPv4
            : (ATYP == 2
                ? new TextDecoder().decode(
                    msg.slice(i + 1, i += 1 + msg.slice(i, i + 1).readUInt8()))       // 域名
                : (ATYP == 3
                    ? msg.slice(i, i += 16)                                            // IPv6
                        .reduce((s, b, idx, a) => (idx % 2 ? s.concat(a.slice(idx - 1, idx + 1)) : s), [])
                        .map(b => b.readUInt16BE(0).toString(16)).join(':')
                    : ''));

        // 回复客户端，建立双向转发
        ws.send(new Uint8Array([VERSION, 0]));
        const duplex = createWebSocketStream(ws);
        net.connect({ host, port }, function () {
            this.write(msg.slice(i));
            duplex.on('error', () => { }).pipe(this).on('error', () => { }).pipe(duplex);
        }).on('error', () => { });
    }).on('error', () => { });
});
