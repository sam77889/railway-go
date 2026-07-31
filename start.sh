#!/bin/sh
# ============================================================
# Railway Argo VLESS-WS 启动脚本
# 
# 职责：
# 1. 启动 Node.js VLESS-WS 服务（监听 PORT）
# 2. 启动 cloudflared Argo 隧道（指向 localhost:PORT）
# 3. 解析隧道域名，生成 VLESS 节点链接
#
# 支持两种模式：
# - 临时隧道：不设 ARGO_TOKEN，自动分配 *.trycloudflare.com
# - 固定隧道：设 ARGO_TOKEN + ARGO_DOMAIN
# ============================================================

set -e

# === 读取配置 ===
PORT=${PORT:-8080}
UUID=${uuid:-79411d85-b0dc-4cd2-b46c-01789a18c650}
NODE_NAME=${NAME:-argo}
ARGO_DOMAIN=${ARGO_DOMAIN:-}
ARGO_TOKEN=${ARGO_TOKEN:-}
CF_IP=${CF_IP:-}

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   Railway Argo VLESS-WS 轻量节点            ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  UUID:     ${UUID}"
echo "  端口:     ${PORT}"
echo "  节点名:   ${NODE_NAME}"
echo ""

# === 1. 启动 Node.js VLESS-WS 服务 ===
node index.js &
NODE_PID=$!
sleep 1

if ! kill -0 "$NODE_PID" 2>/dev/null; then
    echo "[✗] Node.js 启动失败，退出"
    exit 1
fi
echo "[✓] Node.js VLESS-WS 服务已启动 (PID: ${NODE_PID})"

# === 2. 启动 Argo 隧道 ===
if [ -n "$ARGO_TOKEN" ]; then
    # ── 固定隧道模式 ──
    echo ""
    echo "┌─ 模式: Argo 固定隧道 ─────────────────────┐"
    echo "│  域名: ${ARGO_DOMAIN}"
    echo "└────────────────────────────────────────────┘"

    cloudflared tunnel run \
        --token "$ARGO_TOKEN" \
        --no-autoupdate \
        > /tmp/argo.log 2>&1 &
    CF_PID=$!

    # 写入域名供 index.js 读取
    echo "$ARGO_DOMAIN" > /tmp/argo_domain

else
    # ── 临时隧道模式 ──
    echo ""
    echo "┌─ 模式: Argo 临时隧道 ─────────────────────┐"
    echo "│  等待 cloudflared 分配域名...              │"
    echo "└────────────────────────────────────────────┘"

    cloudflared tunnel \
        --url "http://localhost:${PORT}" \
        --no-autoupdate \
        > /tmp/argo.log 2>&1 &
    CF_PID=$!

    # 等待并解析临时隧道域名（最多等 30 秒）
    ARGO_DOMAIN=""
    i=0
    while [ $i -lt 30 ]; do
        ARGO_DOMAIN=$(grep -oE 'https://[a-zA-Z0-9_-]+\.trycloudflare\.com' /tmp/argo.log 2>/dev/null | head -1 | sed 's|https://||')
        if [ -n "$ARGO_DOMAIN" ]; then
            break
        fi
        sleep 1
        i=$((i + 1))
    done

    if [ -z "$ARGO_DOMAIN" ]; then
        echo ""
        echo "[!] 30 秒内未获取到 Argo 隧道域名"
        echo "    可能原因：网络连接问题 / cloudflared 启动失败"
        echo "    查看日志：cat /tmp/argo.log"
        echo ""
        # 即使没拿到域名，也继续运行（健康检查保持容器存活）
    else
        echo "$ARGO_DOMAIN" > /tmp/argo_domain
    fi
fi

# 检查 cloudflared 是否存活
sleep 2
if ! kill -0 "$CF_PID" 2>/dev/null; then
    echo "[!] cloudflared 进程异常退出，查看日志："
    cat /tmp/argo.log 2>/dev/null
    echo ""
    echo "Node.js 服务仍在运行（可通过 Railway 域名直连）"
fi

# === 3. 输出节点信息 ===
echo ""
if [ -n "$ARGO_DOMAIN" ]; then
    # 连接地址：优先用 CF 优选 IP，否则用 Argo 域名
    CONNECT_ADDR=${CF_IP:-$ARGO_DOMAIN}

    VLESS_LINK="vless://${UUID}@${CONNECT_ADDR}:443?encryption=none&security=tls&sni=${ARGO_DOMAIN}&fp=chrome&type=ws&host=${ARGO_DOMAIN}&path=%2F#Vl-${NODE_NAME}"

    echo "╔══════════════════════════════════════════════╗"
    echo "║   ✅ 部署成功                                ║"
    echo "╚══════════════════════════════════════════════╝"
    echo ""
    echo "  Argo 域名:  ${ARGO_DOMAIN}"
    if [ -n "$CF_IP" ]; then
        echo "  CF 优选IP:  ${CF_IP}"
    fi
    echo ""
    echo "  ── VLESS 节点链接（复制到客户端导入）──"
    echo ""
    echo "  ${VLESS_LINK}"
    echo ""
    echo "  ── 订阅/节点页 ──"
    echo ""
    echo "  https://${ARGO_DOMAIN}/${UUID}"
    echo ""
    echo "══════════════════════════════════════════════"
else
    echo "╔══════════════════════════════════════════════╗"
    echo "║   ⚠️  Argo 域名未就绪                       ║"
    echo "╚══════════════════════════════════════════════╝"
    echo ""
    echo "  Node.js 服务正常运行中"
    echo "  等待 cloudflared 重连..."
    echo "  查看日志：cat /tmp/argo.log"
    echo ""
fi

# === 4. 等待主进程 ===
# 监控两个进程，任一退出则重启（依靠 Railway restartPolicy 重拉）
wait $NODE_PID $CF_PID 2>/dev/null
