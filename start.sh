#!/bin/sh
# ============================================================
# Railway Argo VLESS-WS 启动脚本（双隧道版）
#
# 进程模型：
#   1. Node.js VLESS-WS 服务（localhost:PORT）
#   2. cloudflared ①：固定隧道（如设 ARGO_TOKEN）
#   3. cloudflared ②：临时隧道（始终启动）
#
# 域名文件：
#   /tmp/argo_domain_fixed — 固定隧道域名（来自 ARGO_DOMAIN 环境变量）
#   /tmp/argo_domain_tmp   — 临时隧道域名（从 cloudflared 日志解析）
# ============================================================

PORT=${PORT:-8080}
UUID=${uuid:-79411d85-b0dc-4cd2-b46c-01789a18c650}
NODE_NAME=${NAME:-argo}
RAW_DOMAIN=${ARGO_DOMAIN:-}
RAW_TOKEN=${ARGO_TOKEN:-}

# 1. 域名净化：去前缀去后缀
CLEAN_DOMAIN=$(echo "$RAW_DOMAIN" | sed -E 's|^https?://||' | sed -E 's|/+$||')

# 2. Token 智能提取：自动寻找 eyJh 开头的 base64 字符串
CLEAN_TOKEN=$(echo "$RAW_TOKEN" | grep -oE 'eyJh[a-zA-Z0-9=_-]+' | head -n1)

# 3. 单变量拆分：如果没单独填域名，尝试从 RAW_TOKEN 中提取剩余内容作为域名
if [ -z "$CLEAN_DOMAIN" ] && [ -n "$CLEAN_TOKEN" ]; then
    POSSIBLE_DOMAIN=$(echo "$RAW_TOKEN" | sed -E "s|${CLEAN_TOKEN}||g" | sed -E "s|cloudflared(\.exe)?\s+service\s+install||gi" | tr -d ' ,|')
    if [ -n "$POSSIBLE_DOMAIN" ]; then
        CLEAN_DOMAIN=$(echo "$POSSIBLE_DOMAIN" | sed -E 's|^https?://||' | sed -E 's|/+$||')
    fi
fi

ARGO_DOMAIN="$CLEAN_DOMAIN"
ARGO_TOKEN="$CLEAN_TOKEN"
CF_IP=${CF_IP:-}

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   Railway Argo VLESS-WS 轻量节点（双隧道）   ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  UUID:     ${UUID}"
echo "  端口:     ${PORT}"
echo "  节点名:   ${NODE_NAME}"
echo ""

# ── 1. 启动 Node.js VLESS-WS 服务 ──
node index.js &
NODE_PID=$!
sleep 1

if ! kill -0 "$NODE_PID" 2>/dev/null; then
    echo "[✗] Node.js 启动失败，退出"
    exit 1
fi
echo "[✓] Node.js VLESS-WS 服务已启动 (PID: ${NODE_PID})"

# ── 2. 启动固定隧道（如设 ARGO_TOKEN 且解析出 ARGO_DOMAIN）──
CF_FIXED_PID=""
if [ -n "$ARGO_TOKEN" ] && [ -n "$ARGO_DOMAIN" ]; then
    echo ""
    echo "┌─ 固定隧道 ────────────────────────────────┐"
    echo "│  域名: ${ARGO_DOMAIN}"
    echo "└────────────────────────────────────────────┘"

    echo "$ARGO_DOMAIN" > /tmp/argo_domain_fixed

    # Token 格式预检：合法 Token 是 base64url 编码的 JSON（应含 a/t/s 三个字段）
    TOKEN_CHECK=$(node -e "try{const j=JSON.parse(Buffer.from(process.argv[1].replace(/-/g,'+').replace(/_/g,'/'),'base64').toString());console.log(j.a&&j.t&&j.s?'OK':'字段缺失')}catch(e){console.log('无法解析')}" "$ARGO_TOKEN")
    if [ "$TOKEN_CHECK" != "OK" ]; then
        echo "[!] 警告：ARGO_TOKEN 格式异常（${TOKEN_CHECK}），可能复制不完整或隧道已重建"
    fi

    # 注意：--no-autoupdate 是 tunnel 命令级选项，必须放在 run 子命令之前
    cloudflared tunnel \
        --no-autoupdate \
        run \
        --token "$ARGO_TOKEN" \
        > /tmp/argo_fixed.log 2>&1 &
    CF_FIXED_PID=$!

    sleep 5
    if kill -0 "$CF_FIXED_PID" 2>/dev/null; then
        echo "[✓] 固定隧道已启动 (PID: ${CF_FIXED_PID})"
    else
        echo "[✗] 固定隧道启动失败，cloudflared 错误详情："
        echo "────────────────────────────────────────────"
        tail -n 20 /tmp/argo_fixed.log 2>/dev/null
        echo "────────────────────────────────────────────"
        echo "[i] 常见原因：Token 无效 / 隧道被删除或重建 / Token 复制不完整"
        CF_FIXED_PID=""
    fi
else
    echo "[i] 未设 ARGO_TOKEN，跳过固定隧道"
fi

# ── 3. 启动临时隧道（始终启动）──
echo ""
echo "┌─ 临时隧道 ────────────────────────────────┐"
echo "│  等待 cloudflared 分配域名...              │"
echo "└────────────────────────────────────────────┘"

cloudflared tunnel \
    --url "http://localhost:${PORT}" \
    --no-autoupdate \
    > /tmp/argo_tmp.log 2>&1 &
CF_TMP_PID=$!

# 等待并解析临时隧道域名（最多 30 秒）
TMP_DOMAIN=""
i=0
while [ $i -lt 30 ]; do
    TMP_DOMAIN=$(grep -oE 'https://[a-zA-Z0-9_-]+\.trycloudflare\.com' /tmp/argo_tmp.log 2>/dev/null | head -1 | sed 's|https://||')
    if [ -n "$TMP_DOMAIN" ]; then
        break
    fi
    sleep 1
    i=$((i + 1))
done

if [ -n "$TMP_DOMAIN" ]; then
    echo "$TMP_DOMAIN" > /tmp/argo_domain_tmp
    echo "[✓] 临时隧道已启动 (PID: ${CF_TMP_PID})"
    echo "    域名: ${TMP_DOMAIN}"
else
    echo "[!] 30 秒内未获取到临时隧道域名，cloudflared 错误详情："
    echo "────────────────────────────────────────────"
    tail -n 20 /tmp/argo_tmp.log 2>/dev/null
    echo "────────────────────────────────────────────"
fi

# ── 4. 输出节点信息 ──
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   ✅ 部署成功                                ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# 固定隧道节点
if [ -n "$ARGO_DOMAIN" ] && [ -n "$CF_FIXED_PID" ]; then
    FIXED_ADDR=${CF_IP:-$ARGO_DOMAIN}
    FIXED_LINK="vless://${UUID}@${FIXED_ADDR}:443?encryption=none&security=tls&sni=${ARGO_DOMAIN}&fp=chrome&type=ws&host=${ARGO_DOMAIN}&path=%2F#Vl-fixed-${NODE_NAME}"
    echo "  ── 固定隧道 ──"
    echo "  域名: ${ARGO_DOMAIN}"
    echo "  链接: ${FIXED_LINK}"
    echo ""
fi

# 临时隧道节点
if [ -n "$TMP_DOMAIN" ]; then
    TMP_ADDR=${CF_IP:-$TMP_DOMAIN}
    TMP_LINK="vless://${UUID}@${TMP_ADDR}:443?encryption=none&security=tls&sni=${TMP_DOMAIN}&fp=chrome&type=ws&host=${TMP_DOMAIN}&path=%2F#Vl-tmp-${NODE_NAME}"
    echo "  ── 临时隧道 ──"
    echo "  域名: ${TMP_DOMAIN}"
    echo "  链接: ${TMP_LINK}"
    echo ""
fi

# 订阅地址
SUB_DOMAIN=${ARGO_DOMAIN:-$TMP_DOMAIN}
if [ -n "$SUB_DOMAIN" ]; then
    echo "  ── 订阅地址 ──"
    echo "  vless 链接: https://${SUB_DOMAIN}/${UUID}"
    echo "  Clash 配置: https://${SUB_DOMAIN}/${UUID}/clash"
    echo ""
fi
echo "══════════════════════════════════════════════"

# ── 5. 等待进程 ──
# Node.js 是生命线：它退出则容器退出
# cloudflared 退出只打告警（降级为单隧道）
while true; do
    if ! kill -0 "$NODE_PID" 2>/dev/null; then
        echo "[✗] Node.js 进程退出，容器将重启"
        exit 1
    fi
    if [ -n "$CF_FIXED_PID" ] && ! kill -0 "$CF_FIXED_PID" 2>/dev/null; then
        echo "[!] 固定隧道进程退出（降级为临时隧道），退出前日志："
        tail -n 10 /tmp/argo_fixed.log 2>/dev/null
        CF_FIXED_PID=""
    fi
    if [ -n "$CF_TMP_PID" ] && ! kill -0 "$CF_TMP_PID" 2>/dev/null; then
        echo "[!] 临时隧道进程退出（降级为固定隧道），退出前日志："
        tail -n 10 /tmp/argo_tmp.log 2>/dev/null
        CF_TMP_PID=""
    fi
    sleep 30
done
