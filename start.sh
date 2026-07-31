#!/bin/sh
# ============================================================
# Railway Cloudflare Tunnel VLESS-WS 启动脚本（双隧道版）
#
# 进程模型：
#   1. Node.js VLESS-WS 服务（localhost:PORT）
#   2. cloudflared ①：固定隧道（如设 CLOUDFLARE_TUNNEL_TOKEN）
#   3. cloudflared ②：临时隧道（始终启动）
#
# 域名文件：
#   /tmp/cloudflare_tunnel_domain_fixed — 固定隧道域名（来自 CLOUDFLARE_TUNNEL_DOMAIN 环境变量）
#   /tmp/cloudflare_tunnel_domain_tmp   — 临时隧道域名（从 cloudflared 日志解析）
# ============================================================

PORT=${PORT:-8080}
UUID=${uuid:-79411d85-b0dc-4cd2-b46c-01789a18c650}
NODE_NAME=${NAME:-cloudflare_tunnel}
RAW_DOMAIN=${CLOUDFLARE_TUNNEL_DOMAIN:-}
RAW_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN:-}

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

CLOUDFLARE_TUNNEL_DOMAIN="$CLEAN_DOMAIN"
CLOUDFLARE_TUNNEL_TOKEN="$CLEAN_TOKEN"

# 优选 IP 解析：环境变量 CF_IP 优先；未设置时自动从仓库 result.csv 提取延迟最低的 5 个
CF_IP=${CF_IP:-}
if [ -z "$CF_IP" ]; then
    SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
    if [ -f "$SCRIPT_DIR/result.csv" ]; then
        CF_IP=$(awk -F, 'NR>1 && ($4+0)==0 && ($6+0)>0 {print ($5+0), $1}' "$SCRIPT_DIR/result.csv" | sort -n | head -n 5 | awk '{ips = ips (ips ? "," : "") $2} END {print ips}')
        CF_IP_FROM="result.csv"
    fi
else
    CF_IP_FROM="环境变量"
fi
export CF_IP

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   Railway Cloudflare Tunnel VLESS-WS 轻量节点（双隧道）   ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  UUID:     ${UUID}"
echo "  端口:     ${PORT}"
echo "  节点名:   ${NODE_NAME}"
if [ -n "$CF_IP" ]; then
    echo "  优选 IP:  ${CF_IP}（来源: ${CF_IP_FROM}）"
fi
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

# ── 2. 启动固定隧道（如设 CLOUDFLARE_TUNNEL_TOKEN 且解析出 CLOUDFLARE_TUNNEL_DOMAIN）──
CF_FIXED_PID=""
if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ] && [ -n "$CLOUDFLARE_TUNNEL_DOMAIN" ]; then
    echo ""
    echo "┌─ 固定隧道 ────────────────────────────────┐"
    echo "│  域名: ${CLOUDFLARE_TUNNEL_DOMAIN}"
    echo "└────────────────────────────────────────────┘"

    echo "$CLOUDFLARE_TUNNEL_DOMAIN" > /tmp/cloudflare_tunnel_domain_fixed

    # Token 格式预检：合法 Token 是 base64url 编码的 JSON（应含 a/t/s 三个字段）
    TOKEN_CHECK=$(node -e "try{const j=JSON.parse(Buffer.from(process.argv[1].replace(/-/g,'+').replace(/_/g,'/'),'base64').toString());console.log(j.a&&j.t&&j.s?'OK':'字段缺失')}catch(e){console.log('无法解析')}" "$CLOUDFLARE_TUNNEL_TOKEN")
    if [ "$TOKEN_CHECK" != "OK" ]; then
        echo "[!] 警告：CLOUDFLARE_TUNNEL_TOKEN 格式异常（${TOKEN_CHECK}），可能复制不完整或隧道已重建"
    fi

    # 注意：--no-autoupdate 是 tunnel 命令级选项，必须放在 run 子命令之前
    cloudflared tunnel \
        --no-autoupdate \
        run \
        --token "$CLOUDFLARE_TUNNEL_TOKEN" \
        > /tmp/cloudflare_tunnel_fixed.log 2>&1 &
    CF_FIXED_PID=$!

    sleep 5
    if kill -0 "$CF_FIXED_PID" 2>/dev/null; then
        echo "[✓] 固定隧道已启动 (PID: ${CF_FIXED_PID})"
    else
        echo "[✗] 固定隧道启动失败，cloudflared 错误详情："
        echo "────────────────────────────────────────────"
        tail -n 20 /tmp/cloudflare_tunnel_fixed.log 2>/dev/null
        echo "────────────────────────────────────────────"
        echo "[i] 常见原因：Token 无效 / 隧道被删除或重建 / Token 复制不完整"
        CF_FIXED_PID=""
    fi
else
    echo "[i] 未设 CLOUDFLARE_TUNNEL_TOKEN，跳过固定隧道"
fi

# ── 3. 启动临时隧道（始终启动）──
echo ""
echo "┌─ 临时隧道 ────────────────────────────────┐"
echo "│  等待 cloudflared 分配域名...              │"
echo "└────────────────────────────────────────────┘"

cloudflared tunnel \
    --url "http://localhost:${PORT}" \
    --no-autoupdate \
    > /tmp/cloudflare_tunnel_tmp.log 2>&1 &
CF_TMP_PID=$!

# 等待并解析临时隧道域名（最多 30 秒）
TMP_DOMAIN=""
i=0
while [ $i -lt 30 ]; do
    TMP_DOMAIN=$(grep -oE 'https://[a-zA-Z0-9_-]+\.trycloudflare\.com' /tmp/cloudflare_tunnel_tmp.log 2>/dev/null | head -1 | sed 's|https://||')
    if [ -n "$TMP_DOMAIN" ]; then
        break
    fi
    sleep 1
    i=$((i + 1))
done

if [ -n "$TMP_DOMAIN" ]; then
    echo "$TMP_DOMAIN" > /tmp/cloudflare_tunnel_domain_tmp
    echo "[✓] 临时隧道已启动 (PID: ${CF_TMP_PID})"
    echo "    域名: ${TMP_DOMAIN}"
else
    echo "[!] 30 秒内未获取到临时隧道域名，cloudflared 错误详情："
    echo "────────────────────────────────────────────"
    tail -n 20 /tmp/cloudflare_tunnel_tmp.log 2>/dev/null
    echo "────────────────────────────────────────────"
fi

# ── 4. 输出节点信息 ──
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   ✅ 部署成功                                ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# 输出节点链接：$1=隧道域名 $2=标签(fixed/tmp)；先输出域名节点，再为每个优选 IP 输出一条
print_links() {
    PL_DOMAIN="$1"
    PL_TAG="$2"
    echo "  链接: vless://${UUID}@${PL_DOMAIN}:443?encryption=none&security=tls&sni=${PL_DOMAIN}&fp=chrome&type=ws&host=${PL_DOMAIN}&path=%2F#Vl-${PL_TAG}-${NODE_NAME}"
    if [ -n "$CF_IP" ]; then
        PL_IDX=0
        echo "$CF_IP" | tr ',' '\n' | while read -r PL_IP; do
            PL_IP=$(echo "$PL_IP" | tr -d ' ')
            [ -z "$PL_IP" ] && continue
            PL_IDX=$((PL_IDX + 1))
            echo "  链接: vless://${UUID}@${PL_IP}:443?encryption=none&security=tls&sni=${PL_DOMAIN}&fp=chrome&type=ws&host=${PL_DOMAIN}&path=%2F#Vl-${PL_TAG}-${PL_IDX}-${NODE_NAME}"
        done
    fi
}

# 固定隧道节点
if [ -n "$CLOUDFLARE_TUNNEL_DOMAIN" ] && [ -n "$CF_FIXED_PID" ]; then
    echo "  ── 固定隧道 ──"
    echo "  域名: ${CLOUDFLARE_TUNNEL_DOMAIN}"
    print_links "$CLOUDFLARE_TUNNEL_DOMAIN" "fixed"
    echo ""
fi

# 临时隧道节点
if [ -n "$TMP_DOMAIN" ]; then
    echo "  ── 临时隧道 ──"
    echo "  域名: ${TMP_DOMAIN}"
    print_links "$TMP_DOMAIN" "tmp"
    echo ""
fi

# 订阅地址
SUB_DOMAIN=${CLOUDFLARE_TUNNEL_DOMAIN:-$TMP_DOMAIN}
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
        tail -n 10 /tmp/cloudflare_tunnel_fixed.log 2>/dev/null
        CF_FIXED_PID=""
    fi
    if [ -n "$CF_TMP_PID" ] && ! kill -0 "$CF_TMP_PID" 2>/dev/null; then
        echo "[!] 临时隧道进程退出（降级为固定隧道），退出前日志："
        tail -n 10 /tmp/cloudflare_tunnel_tmp.log 2>/dev/null
        CF_TMP_PID=""
    fi
    sleep 30
done
