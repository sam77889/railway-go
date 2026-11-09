# Railway Xray 合并与默认双后端验证

日期：2026-11-09。合并目标为 `cloudflare-tunnel/`，该目录可独立作为部署和 Docker 构建上下文，不依赖旁边的独立部署目录。

## 已通过

- `npm ci --ignore-scripts --offline --no-audit --no-fund`：按现有锁文件安装成功。
- `npm test`：50/50 通过，包含 21 项认证网关测试、7 项 Rust 子进程模块测试、22 项合并集成测试。
- 默认 both 与显式 Node 模式的根路径 VLESS TCP、UDP、Mihomo XUDP 均使用本地真实回显服务验证。
- 默认 both 的三类节点分别使用 `/`、`/vless`、`/trojan`，名称互不重复；仅 Node 节点启用 UDP。未知/带查询串的升级路径被拒绝，同时保持 Node/Rust 活动连接时收到 SIGTERM 能关闭两者。
- Rust 模式的根路径别名、`/vless`、`/trojan`、错误凭据拒绝、禁用路径、后端就绪检查、双域名/优选 IP/双协议订阅及密码转义均通过。
- Node.js、Shell 语法和 JSON 配置检查通过；Dockerfile 做了静态构建步骤检查。
- 独立代码审查通过，确认原 Node 协议处理实现未重写。

## 真实 Rust 产物

固定 v0.1.4 AMD64，SHA256 `bebaa9da6016a55375989abcbe10d2d51123d91ec5465fb033cfc4b7fcc4af72`。

```bash
npm run test:upstream -- /path/to/railway-xray-linux-amd64
```

运行脚本先校验固定产物，再通过 bubblewrap 创建无外网、无主目录、只读运行文件挂载的独立命名空间。不挂载目标目录中的 `.env`、`.env.subscription` 等文件。使用测试凭据运行合并后的实际 `index.js`，验证两种隧道域名、优选 IP 和 VLESS/Trojan 订阅。

默认 both 中，六种真实 TCP 往返均通过：Node VLESS 根路径、Rust VLESS `/vless`、Rust Trojan `/trojan`、Rust VLESS 域名地址编码、Rust Trojan 域名地址编码、Rust VLESS 两字节附加字段。域名编码的内容为 `127.0.0.1`，不涉及外网 DNS。每种均验证首包业务数据和后续数据；Node 根路径还验证了 UDP 首个和后续数据报。双隧道域名及一个优选 IP 共生成 12 条节点，4 条 Node 节点 `udp: true`、8 条 Rust 节点 `udp: false`；SIGTERM 正常退出。

## 启动脚本

使用真实 `start.sh` 和合并后的 Node 主程序，以及临时生成的 cloudflared/Rust 假后端，在离线环境验证：

1. 默认 both 模式拒绝缺失 UUID，不使用公共默认值。
2. 默认 both 模式拒绝格式错误的 UUID。
3. 显式 Node 模式启动双隧道、生成 4 条 VLESS 域名/优选 IP 链接，并清理 Node 与隧道进程。
4. 显式 Rust 模式生成 8 条两协议双隧道链接，停止后清理 Node、Rust 和两个隧道进程。
5. 默认 both 模式生成 12 条三类双隧道链接，正确区分密码、路径、SNI/Host 和 UDP 标记，隔离 Rust 子进程环境，并完整清理四个服务进程。

## 验证边界

Docker daemon 对当前用户不可访问，尚未实际构建镜像。没有创建 Railway 服务或连接真实 Cloudflare 隧道。ARM64、IPv6、外网 DNS 和完整客户端组合尚未验证。Rust 后端仅声明 TCP 支持，不提供 VMess/Shadowsocks/UDP；默认 both 的 UDP/XUDP 由 Node 后端提供。
