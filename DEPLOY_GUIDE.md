# Railway Argo 双隧道节点 — 完整部署操作手册

> 本文档面向**从未使用过 Railway** 的用户，从零开始，一步一步带你完成部署。
>
> 预计耗时：**15 ~ 25 分钟**（含 Cloudflare 隧道配置）

---

## 目录

1. [前置准备](#一前置准备)
2. [第一步：注册 Railway 账号](#二第一步注册-railway-账号)
3. [第二步：将代码推送到 GitHub](#三第二步将代码推送到-github)
4. [第三步：在 Railway 创建项目并部署](#四第三步在-railway-创建项目并部署)
5. [第四步：设置环境变量](#五第四步设置环境变量)
6. [第五步：获取 Cloudflare 固定隧道 Token（双隧道模式）](#六第五步获取-cloudflare-固定隧道-token双隧道模式)
7. [第六步：确认部署成功](#七第六步确认部署成功)
8. [第七步：获取节点链接 / Clash 订阅](#八第七步获取节点链接--clash-订阅)
9. [日常维护操作](#九日常维护操作)
10. [常见问题排查](#十常见问题排查)

---

## 一、前置准备

在开始之前，请确认你已有以下账号和工具：

| 项目 | 说明 | 获取方式 |
|---|---|---|
| **GitHub 账号** | 用于托管代码，Railway 从这里拉取部署 | https://github.com/signup |
| **Railway 账号** | 部署运行服务的平台 | https://railway.com （用 GitHub 直接登录） |
| **Cloudflare 账号** *(可选)* | 仅双隧道模式需要，用于创建固定隧道 | https://dash.cloudflare.com/sign-up |
| **自有域名** *(可选)* | 仅双隧道模式需要，需已托管到 Cloudflare DNS | 任意域名注册商购买 |
| **Git** | 本地推送代码用 | `sudo apt install git` 或 https://git-scm.com |

> **💡 提示**：如果你只是想快速体验，**不需要** Cloudflare 和自有域名。只需 GitHub + Railway 即可一键部署"临时隧道模式"。

---

## 二、第一步：注册 Railway 账号

1. 打开 https://railway.com
2. 点击右上角 **Login** → 选择 **Login with GitHub**。
3. 在弹出的 GitHub 授权页面中，点击 **Authorize Railway**。
4. 首次登录后，Railway 会要求你选择一个计划：
   - **Trial（试用）**：免费，有 $5 额度，但**不绑卡会在 500 小时后停机**。
   - **Hobby（个人）**：$5/月起步，**推荐**。绑定信用卡后按用量计费，本项目月费约 $1.6 ~ $3.5。
5. 建议选择 **Hobby** 计划并绑定信用卡（支持 Visa/Mastercard，国内双币卡可用）。

> **⚠️ 注意**：Trial 计划的 500 小时限制意味着大约 21 天后服务会被暂停。如果你打算长期使用，请升级到 Hobby。

---

## 三、第二步：将代码推送到 GitHub

### 3.1 在 GitHub 上创建空仓库

1. 打开 https://github.com/new
2. 填写仓库信息：
   - **Repository name**：随意取名，例如 `railway-argo-node`
   - **Visibility**：选择 **Private**（私有，推荐）或 Public
   - **其它选项全部留空**（不要勾选 Add a README / .gitignore / License）
3. 点击 **Create repository**。
4. 创建完毕后，页面会显示一段推送指令，**先不要关闭这个页面**。

### 3.2 在本地推送代码

打开终端，执行以下命令（请将 `<你的用户名>` 替换为你的 GitHub 用户名）：

```bash
# 进入项目目录
cd /home/san/railway_docker/argo-tunnel

# 提交所有文件
git add .
git commit -m "feat: railway argo dual-tunnel vless deploy"

# 关联远程仓库（替换为你自己的地址）
git remote add origin https://github.com/<你的用户名>/railway-argo-node.git

# 推送
git branch -M main
git push -u origin main
```

> **如果提示输入密码**：GitHub 已不再支持密码认证，你需要使用 Personal Access Token。
> 前往 https://github.com/settings/tokens → **Generate new token (classic)** → 勾选 `repo` 权限 → 生成后将 Token 当作密码粘贴即可。

推送成功后，刷新 GitHub 仓库页面，应该能看到所有文件（`Dockerfile`、`index.js`、`start.sh` 等）。

---

## 四、第三步：在 Railway 创建项目并部署

### 4.1 从 GitHub 仓库部署

1. 登录 https://railway.com 后台。
2. 点击右上角的 **New Project**（新建项目）。
3. 在弹出的选项中选择 **Deploy from GitHub repo**。
4. 如果是第一次使用，Railway 会要求你授权访问 GitHub：
   - 点击 **Configure GitHub App**。
   - 在 GitHub 页面中选择 **Only select repositories** → 勾选你刚创建的仓库 → 点击 **Install & Authorize**。
5. 回到 Railway 页面后，在仓库列表中**点击你的仓库名称**。
6. Railway 会立即开始构建和部署。

### 4.2 观察构建过程

部署开始后，你会进入项目仪表盘：

1. 点击页面中央的**服务卡片**（显示你仓库名称的那个方块）。
2. 点击顶部的 **Deployments** 标签页。
3. 你会看到一条部署记录，状态为 **Building...**（构建中）。
4. 点击该部署记录，可以实时查看构建日志：
   - `Building Dockerfile...` → 正在构建 Docker 镜像
   - `Successfully built ...` → 构建完成
   - `Deploying...` → 正在启动容器
5. 等待状态变为 ✅ **Active**（活跃），表示部署成功。

> **⏱ 首次构建**大约需要 **2 ~ 3 分钟**（下载 cloudflared 二进制文件）。后续重新部署会更快（有缓存）。

---

## 五、第四步：设置环境变量

这是最关键的一步。你需要告诉服务"你的 UUID 是什么"以及"是否启用双隧道"。

### 5.1 进入环境变量面板

1. 在项目仪表盘中，点击你的**服务卡片**。
2. 点击顶部的 **Variables** 标签页。
3. 你会看到一个变量编辑器。

### 5.2 添加变量

点击 **New Variable** 或 **+ Add**，逐个添加以下变量：

#### 模式一：仅临时隧道（最简配置，适合快速体验）

只需添加 **1 个变量**：

| Variable Name | Value | 说明 |
|---|---|---|
| `uuid` | `你的UUID` | 在终端运行 `uuidgen` 生成一个，或者去 https://www.uuidgenerator.net/ 在线生成 |

添加后点击右上角 **Deploy Changes**（应用更改），Railway 会自动重新部署。

#### 模式二：双隧道并行（推荐，需要 Cloudflare 固定隧道）

添加以下 **3 个变量**：

| Variable Name | Value | 说明 |
|---|---|---|
| `uuid` | `你的固定UUID` | 同上 |
| `ARGO_TOKEN` | `eyJhIjoixxxx...` | 从 Cloudflare 获取（见第五步） |
| `ARGO_DOMAIN` | `proxy.example.com` | 你在 Cloudflare 隧道中绑定的域名 |

可选变量：

| Variable Name | Value | 说明 |
|---|---|---|
| `NAME` | `my-node` | 节点名称前缀，不填默认 `argo` |
| `CF_IP` | `108.162.196.94,104.24.146.138` | Cloudflare 优选 IP，逗号分隔多个（每 IP 一个节点）。不填则自动从仓库 `result.csv` 提取前 5 个低延迟 IP |

### 5.3 填写容错说明

本项目对环境变量的填写有**极高的容错性**，你不需要担心格式问题：

| 场景 | 你粘贴的内容 | 系统行为 |
|---|---|---|
| 复制了 CF 整行安装命令 | `cloudflared.exe service install eyJhIjoixxxx...` | ✅ 自动提取 `eyJh` 开头的 Token |
| 域名带了协议前缀 | `https://proxy.example.com/` | ✅ 自动去除 `https://` 和结尾 `/` |
| Token 和域名填在一起 | `ARGO_TOKEN` 填 `eyJhIjoixxxx... proxy.example.com`，`ARGO_DOMAIN` 留空 | ✅ 自动拆分 Token 和域名 |
| 只填了 Token 没填域名 | `ARGO_TOKEN` 填了，`ARGO_DOMAIN` 留空且 Token 中没有域名 | ✅ 安全降级为仅临时隧道模式 |

### 5.4 应用变量

所有变量填写完毕后：

1. 点击页面右上角的 **Deploy Changes**（部署更改）按钮。
2. Railway 会自动触发一次新的部署。
3. 等待部署状态变为 ✅ **Active**。

> **💡 小技巧**：你也可以用 **RAW Editor** 模式一次性粘贴所有变量。点击变量编辑器右上角的 `RAW Editor` 开关，然后粘贴以下内容：
> ```
> uuid=你的UUID
> ARGO_TOKEN=eyJhIjoixxxx...
> ARGO_DOMAIN=proxy.example.com
> NAME=my-node
> ```
> 粘贴后点击 **Update Variables** → **Deploy Changes**。

---

## 六、第五步：获取 Cloudflare 固定隧道 Token（双隧道模式）

> **如果你只使用临时隧道模式，可以跳过本步骤。**

### 6.1 将域名托管到 Cloudflare

如果你的域名还没有托管到 Cloudflare：

1. 登录 https://dash.cloudflare.com
2. 点击 **Add a site**（添加站点）→ 输入你的域名 → 选择 **Free** 计划。
3. Cloudflare 会给出两个 NS 服务器地址（如 `ada.ns.cloudflare.com`）。
4. 去你的域名注册商后台，将域名的 **NS 记录**改为 Cloudflare 给出的地址。
5. 回到 Cloudflare 点击 **Check nameservers**，等待生效（通常 5 分钟 ~ 24 小时）。

### 6.2 创建 Cloudflare 隧道

1. 登录 https://one.dash.cloudflare.com（Cloudflare Zero Trust 面板）。
2. 左侧菜单点击 **Networks** → **Tunnels**。
3. 点击 **Create a tunnel**（创建隧道）。
4. 选择 **Cloudflared** 作为连接器类型 → 点击 **Next**。
5. 给隧道取个名字（如 `railway-vless`）→ 点击 **Save tunnel**。

### 6.3 复制 Token

创建后会进入安装指引页面，你会看到类似这样的内容：

```
Install and run a connector

...

cloudflared.exe service install eyJhIjoiNGU2ZDc2Y2E3MjZmNTk3NjhhMjNiYTVjMm...
```

**你需要的是 `eyJh` 开头的那一长串字符**。有两种复制方式：

- **精确复制**：只选中 `eyJh...` 开头的部分，复制到 Railway 的 `ARGO_TOKEN` 变量中。
- **偷懒复制**：直接复制整行（包括 `cloudflared.exe service install`），粘贴到 `ARGO_TOKEN` 中。脚本会**自动提取**真正的 Token。

### 6.4 配置 Public Hostname（域名指向）

还在同一页面，点击 **Next** 进入 **Public Hostname** 配置：

1. **Subdomain**：填写子域名前缀（如 `proxy`）。
2. **Domain**：从下拉菜单选择你托管在 Cloudflare 的域名（如 `example.com`）。
   - 组合起来就是 `proxy.example.com` — 这就是你要填到 `ARGO_DOMAIN` 的值。
3. **Service**：
   - **Type** 选择 `HTTP`
   - **URL** 填写 `localhost:8080`
4. 点击 **Save tunnel**。

### 6.5 回到 Railway 填写变量

将以下内容填入 Railway 的环境变量面板：

- `ARGO_TOKEN` → 粘贴你复制的 Token（或整行安装命令）
- `ARGO_DOMAIN` → 填入 `proxy.example.com`（你刚才配置的完整域名）

点击 **Deploy Changes** 触发重新部署。

---

## 七、第六步：确认部署成功

### 7.1 查看部署日志

1. 在 Railway 仪表盘点击你的服务卡片。
2. 点击 **Deployments** → 点击最新的部署记录。
3. 在 **Deploy Logs**（部署日志）中，你应该看到类似以下输出：

```
╔══════════════════════════════════════════════╗
║   Railway Argo VLESS-WS 轻量节点（双隧道）   ║
╚══════════════════════════════════════════════╝

  UUID:     xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  端口:     8080
  节点名:   argo

[✓] Node.js VLESS-WS 服务已启动 (PID: 7)

┌─ 固定隧道 ────────────────────────────────┐
│  域名: proxy.example.com
└────────────────────────────────────────────┘
[✓] 固定隧道已启动 (PID: 13)

┌─ 临时隧道 ────────────────────────────────┐
│  等待 cloudflared 分配域名...              │
└────────────────────────────────────────────┘
[✓] 临时隧道已启动 (PID: 15)
    域名: xxxx-xxxx-xxxx.trycloudflare.com

╔══════════════════════════════════════════════╗
║   ✅ 部署成功                                ║
╚══════════════════════════════════════════════╝
```

### 7.2 关键检查点

| 日志内容 | 含义 |
|---|---|
| `[✓] Node.js VLESS-WS 服务已启动` | 核心代理服务正常 |
| `[✓] 固定隧道已启动` | Token 有效，固定隧道连接成功 |
| `[✓] 临时隧道已启动` + 显示 `.trycloudflare.com` 域名 | 备用隧道正常 |
| `[!] 固定隧道启动失败` | Token 无效或过期，请检查 |
| `[i] 未设 ARGO_TOKEN，跳过固定隧道` | 你没配 Token，正常现象（仅临时隧道模式） |

---

## 八、第七步：获取节点链接 / Clash 订阅

部署成功后，你有两种方式使用节点：

### 8.1 方式一：获取 VLESS 节点链接

在浏览器中访问：

```
https://<你的ARGO域名>/<你的UUID>
```

例如：`https://proxy.example.com/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

页面会返回纯文本的 `vless://` 链接（每行一条）。你可以直接复制到 V2rayN / Nekoray / Shadowrocket 等客户端中导入。

### 8.2 方式二：导入 Clash / Mihomo 订阅（推荐）

这是最方便的方式，订阅会**自动包含双隧道的节点**和**自动故障切换策略**。

**订阅地址：**
```
https://<你的ARGO域名>/<你的UUID>/clash
```

**在 Clash Verge Rev / Mihomo Party 中导入：**

1. 打开 Clash Verge Rev（或 Mihomo Party）。
2. 找到 **订阅管理** / **Profiles** 页面。
3. 点击 **新建** / **Import** / **+**。
4. 在 **URL** 栏粘贴上面的订阅地址。
5. 点击 **导入** / **Save**。
6. 导入成功后，你会看到以下配置被自动加载：
   - **代理组 `🚀 节点选择`**：包含 Auto-Fallback 和手动选择
   - **代理组 `♻️ Auto-Fallback`**：自动优先走固定隧道，失败无感切换到临时隧道
   - **分流规则**：国内直连，境外走代理

7. 在 **Proxies**（代理）页面，选择 `🚀 节点选择` → `♻️ Auto-Fallback`。
8. 点击 **System Proxy**（系统代理）或 **TUN 模式** 开关，即可开始使用。

### 8.3 如果只用了临时隧道（没配固定域名）

临时隧道的域名是 `xxx.trycloudflare.com`，你需要在 Railway 日志中找到它。

1. 进入 Railway → 你的服务 → **Deployments** → 点击最新部署 → 查看日志。
2. 找到 `域名: xxxx-xxxx-xxxx.trycloudflare.com` 这一行。
3. 使用这个域名替代上面的 `<你的ARGO域名>`。

> **⚠️ 注意**：临时隧道域名在每次重启后都会变化。如果你经常使用，强烈建议配置固定隧道。

---

## 九、日常维护操作

### 9.1 修改环境变量

1. Railway 仪表盘 → 点击服务卡片 → **Variables** 标签。
2. 找到要修改的变量 → 点击变量值进行编辑。
3. 修改完成后点击右上角 **Deploy Changes**。
4. Railway 会自动重新部署（约 30 秒 ~ 1 分钟）。

### 9.2 查看实时日志

1. Railway 仪表盘 → 点击服务卡片 → **Deployments** 标签。
2. 点击最新的（状态为 Active 的）部署记录。
3. 切换到 **Deploy Logs** 查看实时输出。

### 9.3 手动重启服务

如果遇到问题需要重启：

1. Railway 仪表盘 → 点击服务卡片 → **Deployments** 标签。
2. 点击页面右上角的 **⋮**（三个点菜单）。
3. 选择 **Restart** → 确认。

### 9.4 暂停 / 恢复服务

如果你暂时不使用，想停止计费：

- **暂停**：服务卡片 → **Settings** 标签 → 向下滚动找到 **Delete Service** 区域上方的暂停/移除选项。
  - 或者直接在 **Deployments** 页面点 **⋮** → **Remove**（移除当前部署）。
- **恢复**：重新触发一次部署（推送一个新 commit，或点击 **⋮** → **Redeploy**）。

### 9.5 查看费用

1. 点击 Railway 左上角头像 → **Usage**（用量）。
2. 可以看到当前周期的 CPU、内存、网络用量和估计费用。

---

## 十、常见问题排查

### Q1：部署后日志显示 "[✗] Node.js 启动失败"

**原因**：通常是 `uuid` 环境变量未设置或格式错误。

**解决**：
1. 进入 **Variables** 确认 `uuid` 变量存在且值是合法的 UUID 格式（如 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）。
2. 注意变量名是小写的 `uuid`，不是 `UUID`。

---

### Q2：固定隧道启动失败，日志显示 "[✗] 固定隧道启动失败"

**原因**：`ARGO_TOKEN` 无效、已失效，或复制不完整。

启动脚本会把 cloudflared 的**错误详情直接打印在失败提示下方的虚线框内**，对号入座：

| 日志中的报错 | 含义与解决 |
|---|---|
| `invalid character` / `Couldn't parse token` / `token is malformed` | Token 复制不完整或被截断。重新完整复制 `eyJh` 开头的整串字符（很长，注意别漏结尾） |
| `unauthorized` / `401` / `403` / `not found` | Token 已失效。隧道被删除或重建过，回 Cloudflare 重新创建隧道并复制新 Token |
| `edge discovery` / 连接超时类报错 | 网络瞬时问题，通常重启部署即可恢复 |

**可选：本地验证 Token 是否有效**

在本机安装 cloudflared 后运行：

```bash
cloudflared tunnel run --token <你的Token>
```

看到 `Connected` 字样说明 Token 有效（Ctrl+C 退出）；立即报错则说明 Token 本身有问题。

**解决步骤**：
1. 回到 Cloudflare Zero Trust → **Networks** → **Tunnels** → 确认隧道存在。
2. 如果隧道已被删除或重建，重新创建隧道，复制新 Token 更新到 Railway 的 `ARGO_TOKEN`。
3. 确认 `ARGO_TOKEN` 变量值是以 `eyJh` 开头的**完整**字符串。

---

### Q3：Clash 订阅导入后显示 0 个节点

**原因**：订阅 URL 中的 UUID 与环境变量中设置的不一致。

**解决**：
1. 确认 URL 中的 UUID 与 Railway Variables 面板里的 `uuid` 值**完全一致**。
2. 确认 URL 格式正确：`https://域名/UUID/clash`（注意最后是 `/clash`）。

---

### Q4：域名可以访问但节点连接失败

**原因**：客户端参数配置错误。

**检查清单**：
- 协议：`VLESS`
- 端口：`443`
- 加密方式：`none`
- 传输协议：`ws`
- 伪装路径（Path）：`/`
- TLS：`开启`
- SNI 和 Host：都填 Argo 域名

---

### Q5：Railway 显示 "Service sleeping" 或服务被暂停

**原因**：Trial 计划的免费额度用完或超时。

**解决**：
1. 升级到 Hobby 计划（$5/月起步，按量扣费）。
2. 或者等待下个月免费额度重置。

---

### Q6：每次重启临时隧道域名都变了怎么办？

这是临时隧道的正常行为。解决方案：

1. **最佳方案**：配置固定隧道（添加 `ARGO_TOKEN` + `ARGO_DOMAIN`），使用 Clash 订阅的自动回退功能。
2. **临时方案**：每次重启后重新从日志中获取新域名。

---

### Q7：延迟很高（200ms+）怎么优化？

Argo 方案的流量链路是 `客户端 → Cloudflare 边缘 → CF 骨干 → 隧道入口 → Railway 容器`，延迟由前两段决定。按效果排序：

**1. 确认 Railway 区域为新加坡（最常见原因）**

默认区域是美西，从国内访问绕路严重：

1. 点击 Railway 左上角头像 → **Settings** → **General**。
2. **Preferred Deployment Region** 选择 **Singapore** → **Update Region**。
3. 回到项目 → **Deployments** → **⋮** → **Redeploy**，让服务迁移到新区域。

**2. 配置 Cloudflare 优选 IP（优化"客户端 → CF 边缘"段）**

1. 下载 [CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest)，在本机运行测速。
   - 不同运营商（电信/联通/移动）的最优 IP 不同，以你本机实测为准。
2. 测速完成后，把生成的 `result.csv` 放进仓库根目录（与 `Dockerfile` 同级），提交推送：
   ```bash
   git add result.csv && git commit -m "update CF IPs" && git push
   ```
3. Railway 自动重新部署，启动脚本会从 `result.csv` 提取**丢包率为 0 且测速有效**的前 5 个低延迟 IP，每个 IP 生成一个节点（`Argo-Fixed-1` ~ `Argo-Fixed-5`），配合 Auto-Fallback 自动选优。
4. 以后优选 IP 劣化时，重新测速 → 替换 `result.csv` → 推送即可，**无需改动 Railway 面板变量**。

> 💡 也可以在 Railway **Variables** 手动设置 `CF_IP`（逗号分隔多个），手动设置的优先级高于 `result.csv`。

**3. 优先使用固定隧道节点**

Clash 代理组选择 `♻️ Auto-Fallback`（默认优先固定隧道），或手动选 `Argo-Fixed`。

**4. 如果以上仍不满足需求**

CF 免费 CDN 的物理绕行决定了 ~150ms 起步。追求极致延迟可改用同目录 [`quick-deploy/`](../quick-deploy/) 直连方案（客户端直连 Railway 新加坡，可低至 60 ~ 120ms），代价是抗封能力弱，适合临时使用。

**延迟参考（国内出发）：**

| 方案 | 典型延迟 |
|---|---|
| 直连 Railway 新加坡 | 60 ~ 120ms |
| Argo 隧道 + 优选 IP | 120 ~ 180ms |
| Argo 隧道默认路由（美西区域） | 200 ~ 350ms |

---

> 📝 如有其他问题，请查阅项目主文档 [README.md](./README.md) 获取更多技术细节。
