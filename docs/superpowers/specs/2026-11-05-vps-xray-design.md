# VPS Xray 重构设计

用户已确认：不用 Cloudflare，面向中国大陆客户端，优先低延时和安全，开始重构。

## 范围与架构

保留当前仓库路径，改为 VPS Docker Compose 部署。TCP 443 映射容器 8443，非 root Xray 是唯一常驻进程；Node.js 22+ 只用于初始化、配置校验和离线导出。协议为 VLESS / RAW / REALITY / Vision。没有 HTTP、WebSocket、在线订阅或管理面板，不再提供 Railway 部署入口。

## 配置与安全

必须指定公网 SERVER_ADDRESS、REALITY_SERVER_NAME、REALITY_PRIVATE_KEY、REALITY_SHORT_ID 和 VLESS_CLIENTS（JSON 数组，设备 name/id）。初始化生成 X25519 私钥、16 位 short ID 和每设备 UUID，持久保存于权限 0600 的 .env，拒绝覆盖。公钥由私钥派生，无需用户维护两份。

启动生成权限 0600 的 /run/xray/config.json，经真实 Xray -test 检查后 exec Xray；检查失败仅输出通用错误。私钥不进入客户端文件，客户端每设备独立文件。默认无访问和 DNS 日志。容器只读、cap_drop ALL、no-new-privileges、仅 /run/xray 为 tmpfs。出站阻止私网、回环、链路本地、云元数据等特殊地址，包含域名解析后的检查；DNS 重绑定的完整隔离还依赖宿主防火墙。

## 客户端

离线生成每设备 VLESS URI 和 Mihomo 配置（JSON 是合法 YAML）。本机监听、无 LAN 共享、DoH 经代理，默认全代理而不隐式开放国内直连。IPv6 默认禁用但不能代替系统防泄漏；系统代理不能覆盖全部应用，系统级断线保护需客户端 TUN/防火墙。备用节点由用户另行部署后添加；本版不自动购买、发布或连接任何 VPS。

## 验证与交付

Node 原生测试覆盖严格配置校验、密钥派生、设备隔离、权限和拒绝覆盖、无凭证日志及安全路由。下载固定版本 Xray 26.10.31 并核验 SHA256，验证生成的服务端配置，尽可能执行真实核心的本地集成测试。Docker daemon 如无权限需明确说明构建验证缺口。大陆延迟、REALITY 目标站兼容性和实际防泄漏需要部署后在用户网络实测，不宣称已完成。
