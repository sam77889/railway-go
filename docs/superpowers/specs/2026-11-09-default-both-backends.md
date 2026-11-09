# 默认并行运行 Node 与 Railway Xray

日期：2026-11-09。用户要求默认同时启动此前合并的两个后端。

- `PROXY_BACKEND` 默认从 `node` 改为 `both`；仍支持显式 `node` 和 `railway-xray`。
- `both` 使用同一个公网 HTTP/WS 端口，Node 处理 `/` 的 VLESS TCP/UDP/XUDP，认证网关处理 `/vless` 和 `/trojan` 并连接内部 Rust TCP 后端。
- 不为同一个 HTTP server 注册竞争的 WS upgrade 监听器；网关统一分发，仅把根路径交给 Node 的 noServer WebSocket server。
- 旧 Node 节点链接和名称不变；both 模式额外生成独立 Rust VLESS `/vless` 节点和 Trojan `/trojan` 节点，避免重名。
- Node 节点继续 `udp: true`；Rust VLESS/Trojan 节点为 `udp: false`。三类节点均支持现有双隧道、优选 IP 和订阅代理组。
- Rust 单模式保持上一版本 VLESS 根路径兼容性；Node 单模式保留原有行为。
- 默认 both 与 Rust 单模式必须提供有效的固定 UUID；后台二进制启动失败时退出，不默默丢弃某个后端。
- Node 主进程退出时同时关闭本地 Node WS 与认证网关，停止并回收 Rust；现有启动脚本继续清理隧道。
- 更新 Docker ENV、Shell 缺省值、环境示例、模板和部署说明。现有 Railway 显式变量优先；已设置 `PROXY_BACKEND=node` 的服务需要改为 `both` 或删除该变量。

验证先覆盖默认 both 的三类节点、不同 UDP 标记、根路径 TCP/UDP/XUDP、Rust 两条路径的转发和拒绝、生命周期与单后端回归，再进行真实 Rust 无外网隔离验证。用户此前已要求推送该项目，验证通过后将本次默认行为调整提交到同一 GitHub main 分支。
