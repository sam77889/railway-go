# Railway Argo VLESS-WS 双隧道轻量节点

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new)

> **Cloudflare Argo 双隧道（固定 + 临时并行） + 纯 Node.js VLESS-WS + Clash / Mihomo 订阅 — Railway 上极高可用与超低成本的抗封节点方案**
>
> 流量链路：`客户端 → Cloudflare CDN (443/TLS) → Argo 双隧道 → cloudflared → Node.js VLESS-WS / 订阅服务 → 目标站点`
>
> 整理时间：2026-07-31

---

## 一、方案概述

本方案在单隧道的基础上升级为 **Argo 双隧道架构** 并内置 **Clash / Mihomo YAML 订阅服务器**。在维持超低内存与成本的同时，实现了节点的高度稳定与自动化切换。

### 与现有方案对比

| 维度 | quick-deploy (直连) | 传统单 Argo 隧道 | **本方案 (Argo 双隧道)** | 完整 argosbx |
|---|---|---|---|---|
| **抗封能力** | ❌ Railway 域名特征明显 | ✅ 隐藏在 CF 后 | ✅ **双重防护 + 自动备用** | ✅ 同等 |
| **高可用性** | ❌ 依赖单域名 | ⚠️ 依赖固定或临时单隧道 | ⚡ **固定 + 临时双隧道并发** | ⚠️ 依赖单隧道 |
| **Clash 订阅** | ❌ | ❌ | ✅ **内置 Clash/Mihomo 自动回退订阅** | ❌ 需额外转换 |
| **启动速度** | ⚡ 秒级 | ⚡ 秒级 | ⚡ **秒级（ cloudflared 预编译）** | 🐢 慢 |
| **运行内存** | ~40MB | ~70MB | **~100MB** | ~200MB+ |
| **月成本估算** | ~$3 | ~$3.5 | **~$1.60 ~ $3.50** | ~$6+ |
| **CDN 优选 IP** | ❌ | ✅ 支持 | ✅ **双节点同时支持优选 IP** | ✅ 支持 |

### 架构图（3 进程布局）

```
                                      ┌────────────────────────────────────────────────────────┐
                                      │                     Railway 容器                        │
                                      │                                                        │
客户端                                │   ┌─────────────────┐    ┌──────────────────────────┐  │     ┌──────┐
┌───────────┐  Cloudflare CDN         │   │  cloudflared    │───→│                          │  │     │      │
│Clash Verge│ ┌───────────────┐ 443/TLS│   │(固定隧道进程)   │    │                          │  │     │      │
│ / Mihomo  │─┼─► ARGO_DOMAIN │───────┼───► └─────────────────┘    │                          │──┼────►│目标  │
│           │ │               │       │                        │ Node.js 服务 (PORT)       │  │     │站点  │
│(Auto-     │ │               │ 443/TLS│   ┌─────────────────┐    │ - VLESS-WS 代理协议      │  │     │      │
│ Fallback) │─┼─► trycloudflare│───────┼───► cloudflared     │───→│ - vless:// 节点链接输出  │──┼────►│      │
└───────────┘ └───────────────┘       │   │(临时隧道进程)   │    │ - Clash YAML 订阅生成器  │  │     └──────┘
                                      │   └─────────────────┘    └──────────────────────────┘  │
                                      │            ↑                           ↑               │
                                      │     双隧道主动出站连接             HTTP / WebSocket     │
                                      └────────────────────────────────────────────────────────┘
```

---

## 二、Railway 成本分析

### 计费规则

| 计费项 | 单价 | 说明 |
|---|---|---|
| vCPU | $0.000463/vCPU/分钟 | 按实际使用量 |
| 内存 | $0.000231/GB/分钟 | 按实际使用量 |
| 出站流量 | $0.10/GB | 每月含 100GB 免费 |
| 磁盘 | $0.000231/GB/分钟 | 含 1GB 免费 |

### 本方案资源占用（3 进程）

| 组件 | 进程数 | CPU | 内存 | 说明 |
|---|---|---|---|---|
| Node.js VLESS + Web/Sub | 1 | ~0.01 vCPU (空闲) | ~40MB | 纯 JS，处理代理及订阅 |
| cloudflared (临时隧道) | 1 | ~0.01 vCPU (空闲) | ~30MB | 始终启动（保底备用） |
| cloudflared (固定隧道) | 1 (可选) | ~0.01 vCPU (空闲) | ~30MB | 配置 Token 后启动 |
| **合计（双隧道空闲）** | **3 进程** | **~0.03 vCPU** | **~100MB** | **超低资源消耗** |
| **合计（单临时隧道空闲）**| **2 进程** | **~0.02 vCPU** | **~70MB** | 未配置 Token 时 |

### 月成本估算（24×7 运行）

| 场景 | vCPU 费 | 内存费 | 合计 |
|---|---|---|---|
| **双隧道空闲待命** | $0.03 × $0.000463 × 43200 ≈ $0.60 | 0.10 × $0.000231 × 43200 ≈ $1.00 | **~$1.60/月** |
| **轻度使用** (4h/天) | ~$0.35 | ~$0.20 | **~$1.80/月** |
| **中度使用** (有传输) | ~$2.00 | ~$1.20 | **~$3.50/月** |

---

## 三、隧道模式说明

本项目的隧道架构支持两种运行模式，由环境变量决定：

| 模式 | 环境变量 | 说明 | 特点 |
|---|---|---|---|
| **仅临时隧道** | 只需设置 `uuid` | 只启动 1 个 cloudflared 进程，自动分配 `*.trycloudflare.com` | 免配置 Cloudflare 域名，适合快速试用（重启会变域名） |
| **双隧道并行** *(推荐)* | 设置 `uuid` + `ARGO_TOKEN` + `ARGO_DOMAIN` | 同时启动固定隧道和临时隧道，生成两个节点 | **固定节点作主用，临时节点作备用**，配合 Clash 自动回退，域名失效秒切 |

---

## 四、部署步骤

### 4.1 准备 GitHub 仓库

```bash
# 进入 argo-tunnel 目录
cd /home/san/railway_docker/argo-tunnel

# 初始化 Git 仓库
git init && git add . && git commit -m "railway argo dual-tunnel vless deploy"

# 在 GitHub 新建一个空仓库，然后推送：
git remote add origin https://github.com/<你的用户名>/railway-argo-node.git
git branch -M main
git push -u origin main
```

### 4.2 Railway 部署

如果你已经将仓库设为 Public（公开），你可以直接点击上方或者下方的**一键部署按钮**：

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new)

或者手动部署：
1. 登录 [Railway](https://railway.com/) → **New Project** → **Deploy from GitHub repo**
2. 选择你刚推送的仓库。
3. Railway 自动识别 Dockerfile 并构建（首次约 2~3 分钟）。

### 4.3 设置环境变量向导

本项目已配置 `template.json` 自动向导，如果您通过模板部署或在 Railway 面板的 **Variables** 标签页中，您会看到如下的配置提示：

#### 模式一：仅临时隧道（最简配置）

* `uuid`：系统已自动为您生成了一个 UUID。如果不使用双隧道，只需保留此 UUID 即可直接部署运行。

#### 模式二：双隧道并行（推荐配置）

* `uuid`：保留系统生成的 UUID 或填入你自己的固定 UUID。
* `ARGO_TOKEN`：填入你从 Cloudflare 获取的隧道 Token（`eyJhIjoixxxx...`）。
* `ARGO_DOMAIN`：填入绑定的自定义域名（如 `your-proxy.example.com`）。
* `NAME`：自定义节点名称前缀。

> **可选：CF 优选 IP**
> 配置 `CF_IP` 变量即可（如 `CF_IP=104.16.0.1`，支持逗号分隔多个：`CF_IP=104.16.0.1,108.162.196.94`）。
> 设置后，每个优选 IP 各生成一个节点（Argo-Fixed-1、Argo-Fixed-2 ...），连接地址使用优选 IP，SNI/Host 仍维持 Argo 域名，配合 Auto-Fallback 自动选优。
> 未手动设置 `CF_IP` 时，启动脚本会自动从仓库根目录的 `result.csv`（CloudflareSpeedTest 测速结果）中提取丢包率为 0 且测速有效的前 5 个低延迟 IP——更新优选 IP 只需替换该文件并推送。

### 4.4 获取 Argo 固定隧道 Token（针对模式二）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 左侧 **Zero Trust** → **Networks** → **Tunnels**
3. 点 **Create a tunnel** → 选 **Cloudflared** → 输入隧道名称
4. 复制显示的 **Token**（`eyJhIjoixxxx...`）→ 填入 Railway 环境变量 `ARGO_TOKEN`
5. 在 **Public Hostname** 添加：
   - Subdomain + Domain = 你想用的域名（如 `proxy.example.com`）
   - Service Type = `HTTP`
   - URL = `localhost:8080`
6. 保存后将该域名填入 Railway 环境变量 `ARGO_DOMAIN`

---

## 五、获取节点与订阅

部署成功后，可通过以下方式使用节点：

### 5.1 VLESS 节点链接提取

在浏览器或 HTTP 客户端访问：
```text
https://<Argo域名>/<你的UUID>
```
将返回纯文本格式的 `vless://` 节点导入链接（每行一条）：
- 包含已就绪的固定隧道节点与临时隧道节点（如 `vless://...`）
- 若隧道域名尚未就绪，则提示 `⏳ Argo 隧道域名尚未就绪，请稍后刷新`

### 5.2 Endpoint 列表

| Endpoint | 类型 | 说明 |
|---|---|---|
| `GET /:uuid` | **VLESS 节点链接** | 返回纯文本 `vless://` 节点导入链接（每行一条） |
| `GET /:uuid/clash` | **Clash / Mihomo YAML** | 返回符合 Mihomo / Clash 规范的完整 YAML 订阅 |

---

## 六、Clash / Mihomo 订阅使用

部署成功后，在 **Clash Verge Rev** / **Mihomo Party** / **Clash Nyanpasu** 中添加远程订阅：

**订阅 URL：**
```text
https://<Argo域名>/<你的UUID>/clash
```

### 订阅自动配置特性

1. **双节点导出（Argo-Fixed + Argo-Tmp）**：同时包含固定隧道节点与临时隧道节点。
2. **Auto-Fallback 自动回退代理组**：
   - 默认优先使用 **Argo-Fixed**（固定隧道）。
   - 当固定隧道断连或域名失效时，秒级自动无缝回退至 **Argo-Tmp**（临时隧道）。
3. **完整 DNS 配置**：内置 `fake-ip` 模式及国内 DNS 分流，防止 DNS 污染。
4. **智能分流规则**：内置国内域名/IP 直连规则，境外流量走 VLESS 节点。

---

## 七、环境变量汇总

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `uuid` | ✅ 必填 | 无 | 节点 UUID，**务必生成固定值** |
| `ARGO_TOKEN` | 否（双隧道必填）| 空 | Cloudflare Zero Trust 隧道 Token |
| `ARGO_DOMAIN` | 否（双隧道必填）| 空 | 固定隧道自定义域名 |
| `NAME` | 否 | `argo` | 节点名称前缀 |
| `CF_IP` | 否 | 自动读 `result.csv` | Cloudflare 优选 IP，逗号分隔多个（每 IP 一个节点）。未设置时自动从仓库 `result.csv` 提取前 5 个低延迟 IP |
| `PORT` | ❌ 不要手动设 | `8080` (Railway 注入)| 内部服务监听端口 |

---

## 八、客户端配置参考

若不使用订阅功能，也可通过手填参数导入客户端：

| 配置项 | 值 |
|---|---|
| 协议 | VLESS |
| 地址 (Address) | Argo 域名 或 CF 优选 IP |
| 端口 (Port) | 443 |
| 用户 ID (UUID) | 你设置的 `uuid` |
| 加密方式 | none |
| 传输协议 (Network) | ws |
| 伪装路径 (Path) | `/` |
| 伪装域名 (Host) | Argo 域名 |
| 传输层安全 (TLS) | tls |
| SNI | Argo 域名 |
| 客户端指纹 | chrome |

---

## 九、工作原理

### 流量链路

```
1. 客户端发起连接 → 访问 Argo 域名 / 优选 IP 的 443 端口 (TLS)
2. 请求到达 Cloudflare CDN 边缘节点
3. Cloudflare 通过 Argo 双隧道长连接转发至容器内对应的 cloudflared 进程
4. cloudflared 将流量解密并转发至本地 Node.js 服务 (localhost:8080)
5. Node.js VLESS 服务验证 UUID 并解包：
   - 若为节点链接 / 订阅请求 (如 /<uuid> 或 /<uuid>/clash)，返回纯文本 vless:// 链接或 YAML 配置文件
   - 若为 VLESS 代理流量，发起 TCP/UDP outbound 连接至目标站点
```

---

## 十、常见问题

| 现象 | 原因与解决方法 |
|---|---|
| 日志显示 "Argo 域名未就绪" | cloudflared 建立隧道需要数秒时间，属于正常等待过程；若持续未就绪请检查 `ARGO_TOKEN` 是否有效。 |
| 临时隧道域名每次重启都变 | 临时隧道特性如此。推荐配置 `ARGO_TOKEN` 与 `ARGO_DOMAIN` 开启双隧道模式，配合 Clash 订阅实现无感切换。 |
| Clash 订阅无法更新 | 确认订阅 URL 格式是否正确：`https://<Argo域名>/<UUID>/clash`，并确保 UUID 与环境变量一致。 |
| 节点连接失败 | 1) 检查客户端 UUID 拼写；2) 检查 TLS 是否开启，SNI 与 Host 是否填入对应的 Argo 域名。 |
| Railway 容器休眠 | Railway 免费/Standard 计划特性；客户端发起请求后会快速唤醒容器。 |

---

## 十一、限制与提示

1. **资源额度**：请关注 Railway 账户月度额度使用情况。
2. **仅 VLESS-WS**：本方案专注于轻量与极速，仅提供 VLESS-WS 协议支持。
3. **无 WARP 解锁**：本节点出口流量直连目标站点，不含 WARP 链式代理；流媒体解锁取决于 Railway 节点出口 IP。
4. **合规提示**：仅供网络技术学习研究与个人合法使用，请遵守相关法律法规及服务提供商条款。

---

## 参考来源

- Cloudflare Tunnel 文档：https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- Railway 文档：https://docs.railway.com/
- 同目录直连方案：[`../quick-deploy/`](../quick-deploy/)
- 流程优化分析：[`../railway-flow-optimization.md`](../railway-flow-optimization.md)
