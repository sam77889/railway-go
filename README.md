# Railway Argo VLESS-WS 轻量节点

> **Cloudflare Argo 隧道 + 纯 Node.js VLESS-WS — Railway 上最低成本的抗封方案**
>
> 流量链路：`客户端 → Cloudflare CDN (443/TLS) → Argo 隧道 → cloudflared → Node.js VLESS-WS → 目标站点`
>
> 整理时间：2026-07-31

---

## 一、为什么选这个方案

### 与现有方案对比

| 维度 | quick-deploy (直连) | 本方案 (Argo 隧道) | 完整 argosbx |
|---|---|---|---|
| **抗封能力** | ❌ Railway 域名特征明显 | ✅ 隐藏在 Cloudflare CDN 后 | ✅ 同等 |
| **启动速度** | ⚡ 秒级 | ⚡ 秒级（cloudflared 预编译） | 🐢 慢（下载 Xray/sing-box） |
| **运行内存** | ~40MB | ~70MB | ~200MB+ |
| **月成本估算** | ~$3 | ~$3.5 | ~$6+ |
| **节点地址** | 需手动改成 Railway 域名 | ✅ 自动生成可用链接 | 需手动改 |
| **CDN 优选 IP** | ❌ | ✅ 支持 | ✅ 支持 |
| **WARP 解锁** | ❌ | ❌ | ✅ |
| **多协议** | VLESS-WS | VLESS-WS | 10+ |

**结论：** 在 Railway 上跑节点，Argo 隧道 + 纯 Node.js 是**抗封能力与成本的最优平衡点**。

### 架构图

```
                                    ┌──────────────────────────┐
                                    │     Railway 容器          │
客户端                Cloudflare    │                          │
┌─────┐  443/TLS   ┌─────────┐    │ ┌────────────┐ ┌──────┐  │     ┌──────┐
│     │───────────→│  CDN    │    │ │cloudflared │→│Node.js│──────→│目标  │
│     │←───────────│  边缘   │    │ │(Argo 隧道) │ │VLESS  │  │     │站点  │
└─────┘            └─────────┘    │ └────────────┘ └──────┘  │     └──────┘
                        ↑         │       ↑                   │
                   用户只看到      │  主动出站连接              │
                   CF 的 IP        │  (不需要暴露入站端口)      │
                                   └──────────────────────────┘
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

### 本方案资源占用

| 组件 | CPU | 内存 | 说明 |
|---|---|---|---|
| Node.js VLESS-WS | ~0.01 vCPU (空闲) | ~40MB | 纯 JS，无内核 |
| cloudflared | ~0.01 vCPU (空闲) | ~30MB | 维持隧道长连接 |
| **合计（空闲）** | **~0.02 vCPU** | **~70MB** | |
| **合计（活跃传输）** | ~0.1 vCPU | ~80MB | 取决于并发 |

### 月成本估算（24×7 运行）

| 场景 | vCPU 费 | 内存费 | 合计 |
|---|---|---|---|
| **空闲待命** | $0.02 × $0.000463 × 43200 ≈ $0.40 | 0.07 × $0.000231 × 43200 ≈ $0.70 | **~$1.10/月** |
| **轻度使用** (4h/天) | ~$0.33 | ~$0.17 | **~$1.60/月** |
| **中度使用** (有传输) | ~$2.00 | ~$1.00 | **~$3.50/月** |

> **Trial 用户（$5 一次性额度）**：轻度使用约可撑 **3 个月**。
>
> **Hobby 用户（$5/月 + 用量）**：月均 $5 + $1~3 = **$6~8/月**。

### 成本优化措施（本方案已内置）

1. ✅ **无 Xray/sing-box 二进制** → 省构建时间 + 运行内存
2. ✅ **cloudflared 预编译进镜像** → 不用每次启动下载 60MB
3. ✅ **Alpine 基础镜像** → 镜像小，拉取快，构建费低
4. ✅ **npm install --production** → 不装开发依赖
5. ✅ **健康检查保活** → 避免不必要的重启（重启 = 额外 CPU 消耗）

---

## 三、部署步骤

### 3.1 准备 GitHub 仓库

```bash
# 进入 argo-tunnel 目录
cd /home/san/railway_docker/argo-tunnel

# 初始化 Git 仓库
git init && git add . && git commit -m "railway argo vless-ws deploy"

# 在 GitHub 新建一个空仓库（如 railway-argo-node），然后：
git remote add origin https://github.com/<你的用户名>/railway-argo-node.git
git branch -M main
git push -u origin main
```

### 3.2 Railway 部署

1. 登录 [Railway](https://railway.com/) → **New Project** → **Deploy from GitHub repo**
2. 选择你刚推送的仓库
3. Railway 自动识别 Dockerfile 并构建（首次约 2~3 分钟）
4. 进入服务 **Settings → Networking → Generate Domain**，得到 `xxx.up.railway.app`

### 3.3 设置环境变量

进入服务 **Variables** 标签，添加：

#### 最简配置（临时隧道）

只需设一个变量即可运行：

```
uuid=你自己生成的UUID
```

> 临时隧道自动分配 `*.trycloudflare.com` 域名，**容器重启后域名会变**。适合临时试用。

#### 推荐配置（固定隧道）

```
uuid=你自己生成的UUID
ARGO_TOKEN=eyJhIjoixxxx...
ARGO_DOMAIN=your-proxy.example.com
NAME=my-argo
```

> 固定隧道域名不变，长期稳定。获取 Token 方法见 [3.4 节](#34-获取-argo-固定隧道-token)。

#### 可选：CF 优选 IP

```
CF_IP=104.16.0.1
```

设置后节点链接地址用此 IP（延迟更低），SNI/Host 仍为 Argo 域名。推荐优选 IP 段：`104.16.0.0/12`、`172.64.0.0/13`。

### 3.4 获取 Argo 固定隧道 Token

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 左侧 **Zero Trust** → **Networks** → **Tunnels**
3. 点 **Create a tunnel** → 选 **Cloudflared** → 输入隧道名称
4. 跳过安装步骤，复制显示的 **Token**（`eyJhIjoixxxx...`）→ 填入 `ARGO_TOKEN`
5. 在 **Public Hostname** 添加：
   - Subdomain + Domain = 你想用的域名（如 `proxy.example.com`）
   - Service Type = `HTTP`
   - URL = `localhost:8080`
6. 保存。把域名填入 `ARGO_DOMAIN`

### 3.5 获取节点

部署成功后，两种方式获取 VLESS 链接：

- **查看部署日志**：启动完成后会打印完整的 `vless://` 链接
- **浏览器访问**：`https://<Argo域名>/<你的UUID>`

复制 `vless://` 链接到客户端导入即可。

---

## 四、环境变量汇总

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `uuid` | ✅ 强烈建议 | 内置默认值（不安全） | 节点 UUID，**必须固定** |
| `ARGO_TOKEN` | 固定隧道必填 | 空（用临时隧道） | Cloudflare Tunnel Token |
| `ARGO_DOMAIN` | 固定隧道必填 | 空 | 固定隧道对应的域名 |
| `NAME` | 否 | `argo` | 节点名称前缀 |
| `CF_IP` | 否 | 空（用 Argo 域名） | Cloudflare 优选 IP |
| `PORT` | ❌ 不要设 | Railway 自动注入 | 内部监听端口 |

---

## 五、客户端配置

VLESS 链接已自带全部参数，直接导入最省事。如需手填：

| 配置项 | 值 |
|---|---|
| 协议 | VLESS |
| 地址 | Argo 域名 或 CF 优选 IP |
| 端口 | 443 |
| UUID | 你设的 `uuid` |
| 加密 | none |
| 传输协议 | ws |
| 路径 | `/` |
| Host | Argo 域名 |
| TLS | tls |
| SNI | Argo 域名 |
| 指纹 | chrome |

推荐客户端：

| 平台 | 推荐 |
|---|---|
| Android | v2rayNG、NekoBox |
| Windows | v2rayN |
| iOS | Shadowrocket |
| macOS | V2rayU、Clash Meta |

---

## 六、工作原理

### 流量链路（6 步）

```
1. 客户端连接 Argo 域名:443 (TLS)
2. DNS 解析到 Cloudflare IP → 请求到达 CF 边缘
3. CF 边缘识别隧道映射 → 经 Argo 隧道发送给容器
4. cloudflared 收到请求 → 转发到 localhost:8080
5. Node.js 解析 VLESS 协议头 → net.connect 连接目标
6. 数据双向流动：目标 ↔ Node.js ↔ cloudflared ↔ CF ↔ 客户端
```

### 为什么比直连更好

| | 直连 Railway | Argo 隧道 |
|---|---|---|
| 入口 | `xxx.up.railway.app`（特征明显） | Cloudflare CDN IP（全球分布） |
| 抗封 | Railway 域名/IP 被封即失效 | 封不了 Cloudflare 整个 IP 段 |
| 端口 | 需要 Railway 暴露端口 | 容器主动出站，无需暴露 |
| 加速 | 无 | Cloudflare 全球 CDN + 智能路由 |
| 成本 | 略低 | 略高（+cloudflared ~30MB RAM） |

---

## 七、文件说明

```
argo-tunnel/
├── Dockerfile        # Alpine 镜像 + 预编译 cloudflared
├── start.sh          # 启动编排：Node.js + cloudflared
├── index.js          # VLESS-WS 服务端（HTTP + WebSocket + VLESS 协议）
├── package.json      # Node 依赖（仅 ws）
├── railway.json      # Railway 部署配置（Dockerfile 构建器）
├── .env.example      # 环境变量说明
├── .gitignore        # Git 忽略规则
└── .dockerignore     # Docker 构建忽略（减小构建上下文）
```

---

## 八、常见问题

| 现象 | 解决 |
|---|---|
| 日志显示"Argo 域名未就绪" | cloudflared 连接 CF 需要几秒；若持续失败检查网络 |
| 临时隧道域名变了 | 正常，容器重启会换域名；用固定隧道避免 |
| 节点连不上 | 1) 检查 UUID 是否一致 2) 客户端 TLS 是否开启 3) SNI/Host 是否填 Argo 域名 |
| Railway 容器休眠 | 免费版特性；首次连接会唤醒（~5-10 秒延迟） |
| 想要 WARP 解锁流媒体 | 本方案不含 WARP；需要的话用完整 argosbx 镜像 |
| 构建失败 | 检查 Railway 是否支持 Dockerfile 构建；确认 cloudflared 下载链接可达 |

---

## 九、限制与提示

1. **免费额度有限**：Railway Trial $5 用完即停；Hobby $5/月起。
2. **非 7×24（免费版）**：容器空闲会休眠，唤醒有延迟；Hobby 版可设 Always-on。
3. **仅 VLESS-WS**：本方案为轻量化只做 VLESS-WS；需多协议用完整 argosbx。
4. **无 WARP**：不含 WARP 出站，流媒体解锁依赖出口 IP。
5. **临时隧道域名不固定**：重启会变；长期使用**必须用固定隧道**。
6. **合规**：仅供学习网络协议与容器化部署，请遵守所在地区法律法规及 Railway/Cloudflare 服务条款。

---

## 参考来源

- argosbx 项目：https://github.com/yonggekkk/argosbx
- Cloudflare Tunnel 文档：https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- Railway 文档：https://docs.railway.com/
- 同目录直连方案：[`../quick-deploy/`](../quick-deploy/)
- 流程优化分析：[`../railway-flow-optimization.md`](../railway-flow-optimization.md)

---

*基于 argosbx (V25.11.20) 架构精简，cloudflared 使用最新稳定版。Railway 平台政策可能变化，以官方最新说明为准。*
