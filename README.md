# VPS Xray REALITY

VPS 直连部署：VLESS + RAW/TCP + REALITY + Vision，无 Cloudflare 中转。Xray 处理全部代理流量；Node.js 只负责启动前配置生成和离线导出，没有公网 HTTP、订阅接口或管理面板。

本目录沿用旧名称 `cloudflare-tunnel/`，内容已迁移到 VPS 架构。旧版 VLESS-WS 配置不兼容，需要重新导入。Railway 当前明确禁止代理/VPN，因此本版不提供 Railway 部署配置：[官方说明](https://docs.railway.com/platform/trust-and-safety)。

```text
客户端 ── TCP 443 / REALITY ──> VPS Docker 映射 ──> Xray:8443 ──> 目标网站
```

## 快速开始

准备允许该用途、具有公网 IP 的 Linux VPS，安装 Docker Engine + Compose v2；配置工具需要 Node.js 22+。支持 amd64 / arm64，默认公网 TCP 443 必须未被其他程序占用。

在本目录执行，替换下面两个参数：

```bash
# 第一个参数是 VPS 公网 IP；第二个是你验证过的 REALITY 目标站域名。
# 不填设备名时只生成 phone；不要把占位符原样复制。
npm run init -- YOUR_VPS_IP YOUR_REALITY_TLS_HOST phone laptop

# 导出离线客户端文件；目录必须尚不存在。
npm run export -- clients

# 在 VPS 上构建、启动。
docker compose up -d --build
docker compose ps
docker compose logs --tail 20
```

无需 `npm install`，本项目没有第三方 Node 依赖。初始化生成 `.env`（0600），已有文件会拒绝覆盖。保持设备 UUID、REALITY 密钥和 short ID 固定，重启不会重新生成。

`REALITY_SERVER_NAME` 不是 VPS 域名，也不是订阅域名；它是 VPS 可访问、支持 TLS 1.3 和 HTTP/2 的目标站。目标地址由该域名和 443 端口组成。不要填 VPS 本身，避免连接回环。目标站选择与本地网络测试见 [部署指南](DEPLOY_GUIDE.md)。

## 客户端

每设备生成两份敏感文件，仅分发对应设备的文件：

```text
clients/
├── phone.vless.txt
├── phone.mihomo.yaml
├── laptop.vless.txt
└── laptop.mihomo.yaml
```

已通过本地端到端测试的核心版本为 **Xray 26.10.31** 和 **Mihomo 1.19.33**。Mihomo 文件是 JSON 格式的合法 YAML，可作为本地配置导入。文件只含该设备 UUID 和服务端公钥，不含私钥或其他设备凭证。

固定版本 Xray 要求客户端 ClientHello 包含 X25519MLKEM768 密钥交换。Mihomo 请优先导入完整配置，其中已设置 `reality-opts.support-x25519mlkem768: true`；只导入 VLESS 链接不会可靠携带这个非通用参数，需要手动确认它已开启。其他客户端必须具备对应握手支持，不能仅以“支持 REALITY/Vision”判断兼容，也不要通过跳过证书校验解决连接失败。

Mihomo 默认：代理监听 `127.0.0.1:7890`，DNS 监听 `127.0.0.1:1053`，禁止 LAN 共享，普通目标 DNS 使用经代理的 DoH，全代理且不配置 DIRECT 回退。节点域名引导解析使用直连 DoH，推荐节点地址填写公网 IP 减少引导依赖。没有国内直连规则，避免隐式降低隐私保护；需要分流时自行明确添加。

这些设置不等于系统级断线保护：浏览器“系统代理”不会覆盖所有应用。需要在所选客户端配置 TUN、DNS 接管及其支持的严格路由/断线保护，检查 IPv6 和 UDP 行为；不能仅靠 `ipv6: false` 保证不泄漏。关闭客户端或系统代理失效时，操作系统仍可能直连。

## 安全与维护

- 服务端默认关闭访问、错误与 DNS 流量日志；启动脚本只输出通用状态，不打印凭证。排错不要把 `.env`、完整配置或客户端链接粘贴到公共日志。
- Xray 非 root 运行，根文件系统只读，删除 Linux capabilities；运行配置只写入内存 tmpfs。服务端出站使用 Xray `finalRules` 阻断回环、私网、链路本地、云元数据及部分保留地址，也检查域名解析后的地址。宿主机防火墙仍应提供出站隔离，特别是 DNS 重绑定和 VPS 自身公网 IP/管理端口；这里不承诺替代网络层防火墙。
- 仅发布 TCP 443（映射容器 8443），没有 UDP 公网监听；支持的 UDP 由核心封装在代理连接内传输，不能据此承诺低延时游戏或所有 QUIC 场景可用。SSH 只对管理来源开放，使用密钥认证。
- `.env` 包含服务端私钥，应加密备份。环境变量可被 Docker 管理员及宿主 root 读取，不抵御宿主失陷。已导出的客户端文件同样是凭证。
- 旧版真实 Tunnel Token 已进入 Git 历史，需在 Cloudflare 轮换/撤销；删除当前文件不等于清除历史。本次不重写 Git 历史。

撤销设备：从 `.env` 的 `VLESS_CLIENTS` 删除对应设备，然后 `docker compose up -d --force-recreate`。新增设备用 `node -e 'console.log(require("node:crypto").randomUUID())'` 生成 UUID v4，添加唯一的 `name/id`；用新的导出目录重新导出。私钥轮换会使所有旧客户端失效，应安排完整重新分发。

## 低延时与验证

先在一个区域部署，从实际使用的运营商网络测试晚高峰连接成功率、丢包、网页首字节时间和 P95 延迟。香港、日本、新加坡只是候选，线路质量比物理距离更重要。需要备用时，另选供应商/网络独立部署，不复用私钥；客户端组只放代理节点，不把 DIRECT 当故障回退。

REALITY 不保证无法识别、不会封锁或匿名；HTTPS 网站仍应保持端到端证书校验。配置工具不能证明中国大陆可达性，也不会自动测试目标站是否适合 REALITY。

```bash
npm test
# 下载并校验对应版本核心后，可显式启用真实核心集成验证：
XRAY_BIN=/absolute/path/to/xray MIHOMO_BIN=/absolute/path/to/mihomo npm run test:integration
```

Xray 固定为 **26.10.31**，构建对 amd64/arm64 下载包校验各自 SHA256，不使用 `latest`。启动先运行真实核心的配置检查，失败即退出；停止信号直接交给 Xray。没有持续健康监测或“自动修复网络”的承诺。

参考：[REALITY](https://xtls.github.io/en/config/transports/reality.html)、[Xray 发布](https://github.com/XTLS/Xray-core/releases/tag/v26.10.31)、[Mihomo DNS](https://wiki.metacubex.one/config/dns/)。`docs/superpowers/` 中 2026-11-05 之前的文档仅为旧版历史设计。
