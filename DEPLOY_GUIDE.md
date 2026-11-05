# VPS 部署与迁移

## 1. 准备主机

选择允许该用途、有公网 IP、可开放 TCP 443 的 Linux VPS。安装官方 Docker Engine、Compose v2 和 Node.js 22+。用实际运营商网络挑选线路，先验证一台，再考虑不同网络的备用节点。

检查 443 占用和防火墙规则，按实际管理地址限制 SSH。Docker 发布端口可能经过独立防火墙链，不能只看 UFW 的显示结果；应从另一台主机验证真正暴露的端口。不要自动覆盖宿主已有网络规则。

## 2. 确认 REALITY 目标站

目标站是你选定的公共 TLS 主机，必须从 VPS 可达，支持 TLS 1.3 / HTTP/2。它与客户端连接的 VPS IP 是不同概念，不要求把任何域名解析到 VPS，也不用申请自己的 TLS 证书。

将命令中的 `YOUR_REALITY_TLS_HOST` 换成候选域名，在 VPS 手动检查：

```bash
openssl s_client -connect YOUR_REALITY_TLS_HOST:443 \
  -servername YOUR_REALITY_TLS_HOST -tls1_3 -alpn h2 -verify_return_error </dev/null
```

检查证书验证成功和 ALPN `h2`。这只是基础条件，最终还需 REALITY 客户端端到端验证。目标域名不要解析到 VPS 本身、回环、私网或云元数据。不要批量扫描无关主机。

## 3. 初始化与离线导出

进入本仓库目录：

```bash
npm run init -- YOUR_VPS_IP YOUR_REALITY_TLS_HOST phone laptop
npm run export -- clients
```

命令生成 `.env`、每设备一个 UUID、服务端 X25519 私钥和 short ID，不打印秘密。`.env` 0600、导出目录 0700、客户端文件 0600；已有文件或目录不覆盖。设备名称限 1..32 个英文字母、数字、下划线和连字符，首字符是字母或数字。

可以在可信本地电脑初始化，然后使用 SSH/SCP 安全传输 `.env` 至 VPS 同目录，并确认 `chmod 600 .env`；不要将 `.env` 推送到 Git。向手机只传 `phone.*`，向电脑只传对应文件。客户端不需要服务端私钥。

所有环境变量定义在 [.env.example](.env.example)。`SERVER_ADDRESS` 仅做 IP/域名语法校验，不自动判断公网可达性；公网部署必须填写实际可达的 VPS 公网地址，不要填内网/回环地址。`SERVER_PORT` 默认 443，既用于 Compose 端口映射，也用于导出客户端地址；修改后重建容器并重新分发客户端。内部监听固定 8443，不使用 Railway `PORT`。

## 4. 启动与检查

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail 20
```

启动顺序：校验必填参数 → 写内存配置 → Xray `run -test` → `exec` Xray。任一验证失败都不会启动代理。配置检查输出默认隐藏，以免核心错误信息暴露私钥；只显示通用失败提示。

日志出现 `Configuration validated; starting Xray.` 只代表本机配置有效，不证明外部网络、REALITY 目标站或大陆客户端可用。用真实客户端导入后访问 HTTPS 页面验证。`curl https://VPS_IP` 不是有效的 REALITY 代理测试，不提供 `/health`、UUID 路径或在线订阅。

配置有误时先核对 `.env` 字段格式、端口、目标站连接，运行 `npm test`。若必须执行核心详细检查，仅在可信终端中生成配置并运行 `xray run -test -config FILE`；不要公开输出，完成后妥善处理包含私钥的文件。服务端日常访问、DNS 与错误流量日志关闭，Docker 只保留有限启动信息。

## 5. 客户端路由与防泄漏

已验证 Xray 26.10.31 和 Mihomo 1.19.33。Mihomo 优先导入对应设备的 `.mihomo.yaml`，它明确开启 `reality-opts.support-x25519mlkem768: true`；当前服务端要求对应混合密钥交换握手，旧客户端可能不兼容。单条 `.vless.txt` 不能保证导入器携带此非通用参数，导入后需要手动确认；不要关闭证书校验来规避失败。

完整 Mihomo 配置默认全代理，无 DIRECT 故障回退；单条 VLESS 链接只有节点参数，不包含 DNS、路由或断线保护配置。

- 在客户端配置 TUN/DNS 接管，系统级断线保护使用该客户端支持的严格路由或防火墙功能。
- 系统代理模式通常不能覆盖所有应用；浏览器 DoH、IPv6 和应用自带 UDP 可能绕过它，需要实测。
- 从客户端断开代理、停止核心、切换 Wi-Fi/移动网络，检查需要保护的应用是否仍能直连。
- 代理 DNS 默认只监听本机 1053；导入配置本身不会把系统 DNS 自动指向该端口。需要客户端接管才能覆盖系统解析。
- 国内直连属于主动降低代理覆盖范围，按实际需求添加规则，不把 DIRECT 加入故障回退组。

## 6. 设备撤销、备份与升级

在 `.env` 的 `VLESS_CLIENTS` JSON 数组中添加/删除设备，UUID 用本地 `node -e 'console.log(require("node:crypto").randomUUID())'` 生成。设备 UUID 必须唯一；名称不能与客户端内置策略及 `PROXY` 组冲突。

```bash
docker compose up -d --force-recreate
npm run export -- clients-updated
```

撤销通过重建容器生效，会断开旧连接；重新导出不会自动删除其他设备已持有的文件。导出目录必须是新目录，避免误覆盖。

服务端私钥变更需要全部设备更新；设备凭证泄露时可只替换/撤销该设备 UUID。加密备份 `.env`，不备份 `/run/xray` tmpfs。停止使用时执行 `docker compose down`；此命令保留本地 `.env` 和导出文件。

更新 Xray 时同时更新 Dockerfile 的版本、两个架构的 SHA256 并运行测试与真实核心检查；不要仅修改版本号。Node 基础镜像在同一 LTS 大版本内获取补丁，发布镜像前应进行构建和依赖扫描。

## 7. 从旧版迁移

旧版 Cloudflare 双隧道、临时域名、优选 IP、WS 节点和 Railway 模板已移除；旧 UUID URL 和订阅链接不再可用。更新所有客户端后，再停止旧部署，避免重复费用。

此前明文 Tunnel Token 已进入旧 Git 提交，应在 Cloudflare 撤销/轮换；本次移除当前副本，没有清理远端历史。根目录的旧 Railway 指南、`quick-deploy/` 和历史设计文档不属于本次迁移产物，不应继续照其部署本版本。
