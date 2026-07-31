# ============================================================
# Railway Argo VLESS-WS 轻量节点 — Dockerfile
# 
# 设计目标：极致轻量，最低成本
# - node:20-alpine 基础镜像（~50MB）
# - cloudflared 预编译二进制（~60MB）
# - 运行时内存 ~60-80MB（Node ~40MB + cloudflared ~30MB）
# - 无 Xray/sing-box，纯 Node.js 实现 VLESS 协议
# ============================================================

FROM node:20-alpine

# 安装 cloudflared（仅支持 amd64，Railway 默认架构）
RUN apk add --no-cache curl \
    && curl -Lo /usr/local/bin/cloudflared \
       https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    && chmod +x /usr/local/bin/cloudflared \
    && apk del curl \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# 先复制 package.json 利用 Docker 层缓存
COPY package.json ./
RUN npm install --production && npm cache clean --force

# 复制应用代码
COPY . .
RUN chmod +x start.sh

CMD ["sh", "start.sh"]
