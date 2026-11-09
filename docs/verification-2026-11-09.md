# Railway Xray 合并验证

日期：2026-11-09。合并目标为 `cloudflare-tunnel/`，该目录可独立作为部署和 Docker 构建上下文，不依赖旁边的独立部署目录。

## 已通过

- `npm ci --ignore-scripts --offline --no-audit --no-fund`：按现有锁文件安装成功。
- `npm test`：40/40 通过，包含 21 项认证网关测试、7 项 Rust 子进程模块测试、12 项合并集成测试。
- 默认 Node 模式的根路径 VLESS TCP、UDP、Mihomo XUDP 均使用本地真实回显服务验证。
- Rust 模式的根路径别名、`/vless`、`/trojan`、错误凭据拒绝、禁用路径、后端就绪检查、双域名/优选 IP/双协议订阅及密码转义均通过。
- Node.js、Shell 语法和 JSON 配置检查通过；Dockerfile 做了静态构建步骤检查。
- 独立代码审查通过，确认原 Node 协议处理实现未重写。

## 真实 Rust 产物

固定 v0.1.4 AMD64，SHA256 `bebaa9da6016a55375989abcbe10d2d51123d91ec5465fb033cfc4b7fcc4af72`。

```bash
npm run test:upstream -- /path/to/railway-xray-linux-amd64
```

运行脚本先校验固定产物，再通过 bubblewrap 创建无外网、无主目录、只读运行文件挂载的独立命名空间。不挂载目标目录中的 `.env`、`.env.subscription` 等文件。使用测试凭据运行合并后的实际 `index.js`，验证两种隧道域名、优选 IP 和 VLESS/Trojan 订阅。

六种真实 TCP 往返均通过：VLESS 根路径、VLESS `/vless`、Trojan `/trojan`、VLESS 域名地址编码、Trojan 域名地址编码、VLESS 两字节附加字段。域名编码的内容为 `127.0.0.1`，不涉及外网 DNS。每种均验证首包业务数据和后续数据；SIGTERM 正常退出。

## 启动脚本

使用真实 `start.sh` 和合并后的 Node 主程序，以及临时生成的 cloudflared/Rust 假后端，在离线环境验证：

1. Rust 模式拒绝缺失 UUID，不使用公共默认值。
2. Rust 模式拒绝格式错误的 UUID。
3. 默认 Node 模式启动双隧道、生成 VLESS 域名/优选 IP 链接，并清理 Node 与隧道进程。
4. Rust 模式生成两协议双隧道链接、正确编码特殊密码、隔离子进程环境，并在停止后清理 Node、Rust 和两个隧道进程。

## 验证边界

Docker daemon 对当前用户不可访问，尚未实际构建镜像。没有创建 Railway 服务或连接真实 Cloudflare 隧道。ARM64、IPv6、外网 DNS 和完整客户端组合尚未验证。Rust 模式仅声明 TCP 支持，不提供 VMess/Shadowsocks/UDP。
