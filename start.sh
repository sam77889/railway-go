#!/bin/sh
# Node supervises the optional Rust backend; this script supervises Node and tunnels.

umask 077
PORT=${PORT:-8080}
PROXY_BACKEND=${PROXY_BACKEND:-node}
NODE_NAME=${NAME:-cloudflare_tunnel}
STATE_DIR=${TUNNEL_STATE_DIR:-/tmp}
NODE_PID=""
CF_FIXED_PID=""
CF_TMP_PID=""
SLEEP_PID=""
STATE_READY=0

cleanup() {
    trap - EXIT
    trap '' INT TERM
    for PID in "$NODE_PID" "$CF_FIXED_PID" "$CF_TMP_PID" "$SLEEP_PID"; do
        [ -z "$PID" ] || kill -TERM "$PID" 2>/dev/null || :
    done
    # Give Node enough time to perform its own five-second Rust shutdown.
    COUNT=0
    while [ "$COUNT" -lt 6 ]; do
        ALIVE=""
        for PID in "$NODE_PID" "$CF_FIXED_PID" "$CF_TMP_PID" "$SLEEP_PID"; do
            if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then ALIVE=1; fi
        done
        [ -n "$ALIVE" ] || break
        sleep 1
        COUNT=$((COUNT + 1))
    done
    for PID in "$NODE_PID" "$CF_FIXED_PID" "$CF_TMP_PID" "$SLEEP_PID"; do
        [ -z "$PID" ] || kill -KILL "$PID" 2>/dev/null || :
        [ -z "$PID" ] || wait "$PID" 2>/dev/null || :
    done
    if [ "$STATE_READY" = 1 ]; then
        rm -f "$STATE_DIR/cloudflare_tunnel_domain_fixed" "$STATE_DIR/cloudflare_tunnel_domain_tmp"
    fi
}
trap cleanup EXIT
trap 'exit 0' INT TERM

pause() {
    sleep "$1" &
    SLEEP_PID=$!
    wait "$SLEEP_PID" 2>/dev/null || :
    SLEEP_PID=""
}

node_alive() {
    if ! kill -0 "$NODE_PID" 2>/dev/null; then
        echo "[✗] Node.js 进程退出，容器将重启"
        exit 1
    fi
}

case "$PROXY_BACKEND" in
    node) UUID=${uuid:-79411d85-b0dc-4cd2-b46c-01789a18c650} ;;
    railway-xray)
        UUID=$(node -e 'const value=(process.env.uuid||"").toLowerCase(); if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))process.exit(1); process.stdout.write(value)') || {
            echo "[✗] railway-xray 模式必须提供自己的有效 uuid"
            exit 1
        }
        ;;
    *) echo "[✗] PROXY_BACKEND 只支持 node 或 railway-xray"; exit 1 ;;
esac

RAW_DOMAIN=${CLOUDFLARE_TUNNEL_DOMAIN:-}
RAW_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN:-}
clean_domain() {
    printf '%s\n' "$1" | sed -E 's|^[[:space:]]+||; s|[[:space:]]+$||; s|^https?://||; s|/+$||'
}
CLEAN_DOMAIN=$(clean_domain "$RAW_DOMAIN")
CLEAN_TOKEN=$(printf '%s\n' "$RAW_TOKEN" | grep -oE 'eyJh[a-zA-Z0-9=_-]+' | head -n1)
if [ -z "$CLEAN_DOMAIN" ] && [ -n "$CLEAN_TOKEN" ]; then
    POSSIBLE_DOMAIN=$(printf '%s\n' "$RAW_TOKEN" | sed -E "s|${CLEAN_TOKEN}||g; s|cloudflared(\.exe)?[[:space:]]+service[[:space:]]+install||gi" | tr -d ' ,|')
    CLEAN_DOMAIN=$(clean_domain "$POSSIBLE_DOMAIN")
fi

uuid=$UUID
NAME=$NODE_NAME
BACKEND_PORT=${BACKEND_PORT:-3001}
CLOUDFLARE_TUNNEL_DOMAIN=$CLEAN_DOMAIN
CLOUDFLARE_TUNNEL_TOKEN=$CLEAN_TOKEN
TUNNEL_STATE_DIR=$STATE_DIR
export uuid PORT NAME PROXY_BACKEND BACKEND_PORT
export CLOUDFLARE_TUNNEL_DOMAIN CLOUDFLARE_TUNNEL_TOKEN TUNNEL_STATE_DIR

if ! mkdir -p "$STATE_DIR" || ! rm -f "$STATE_DIR/cloudflare_tunnel_domain_fixed" "$STATE_DIR/cloudflare_tunnel_domain_tmp"; then
    echo "[✗] 无法初始化隧道状态目录: $STATE_DIR"
    exit 1
fi
STATE_READY=1

CF_IP=${CF_IP:-}
CF_IP_FROM="环境变量"
if [ -z "$CF_IP" ]; then
    SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
    if [ -f "$SCRIPT_DIR/result.csv" ]; then
        CF_IP=$(awk -F, 'NR>1 && ($4+0)==0 && ($6+0)>0 {print ($5+0), $1}' "$SCRIPT_DIR/result.csv" | sort -n | head -n 5 | awk '{ips = ips (ips ? "," : "") $2} END {print ips}')
        CF_IP_FROM="result.csv"
    fi
fi
export CF_IP

echo ""
echo "Railway Cloudflare Tunnel 双隧道节点"
echo "  后端: $PROXY_BACKEND"
echo "  端口: $PORT"
echo "  节点名: $NAME"
if [ -n "$CF_IP" ]; then echo "  优选 IP: $CF_IP（来源: $CF_IP_FROM）"; fi

node index.js &
NODE_PID=$!
pause 1
node_alive
echo "[✓] Node.js 网关已启动 (PID: $NODE_PID)"

if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ] && [ -n "$CLOUDFLARE_TUNNEL_DOMAIN" ]; then
    printf '%s\n' "$CLOUDFLARE_TUNNEL_DOMAIN" > "$STATE_DIR/cloudflare_tunnel_domain_fixed" || exit 1
    TOKEN_CHECK=$(node -e 'try{const value=JSON.parse(Buffer.from(process.env.CLOUDFLARE_TUNNEL_TOKEN,"base64url").toString());console.log(value.a&&value.t&&value.s?"OK":"字段缺失")}catch{console.log("无法解析")}')
    if [ "$TOKEN_CHECK" != "OK" ]; then echo "[!] 固定隧道 Token 格式异常（$TOKEN_CHECK）"; fi
    cloudflared tunnel --no-autoupdate run --token "$CLOUDFLARE_TUNNEL_TOKEN" \
        > "$STATE_DIR/cloudflare_tunnel_fixed.log" 2>&1 &
    CF_FIXED_PID=$!
    pause 5
    node_alive
    if kill -0 "$CF_FIXED_PID" 2>/dev/null; then
        echo "[✓] 固定隧道进程已启动 (PID: $CF_FIXED_PID)，域名: $CLOUDFLARE_TUNNEL_DOMAIN"
    else
        echo "[✗] 固定隧道启动失败："
        tail -n 20 "$STATE_DIR/cloudflare_tunnel_fixed.log" 2>/dev/null
        wait "$CF_FIXED_PID" 2>/dev/null || :
        CF_FIXED_PID=""
    fi
else
    echo "[i] 固定隧道 Token/域名未同时设置，使用临时隧道"
fi

cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate \
    > "$STATE_DIR/cloudflare_tunnel_tmp.log" 2>&1 &
CF_TMP_PID=$!
TMP_DOMAIN=""
COUNT=0
while [ "$COUNT" -lt 30 ]; do
    node_alive
    TMP_DOMAIN=$(grep -oE 'https://[a-zA-Z0-9_-]+\.trycloudflare\.com' "$STATE_DIR/cloudflare_tunnel_tmp.log" 2>/dev/null | head -n1 | sed 's|https://||')
    [ -z "$TMP_DOMAIN" ] || break
    kill -0 "$CF_TMP_PID" 2>/dev/null || break
    pause 1
    COUNT=$((COUNT + 1))
done
if [ -n "$TMP_DOMAIN" ]; then
    printf '%s\n' "$TMP_DOMAIN" > "$STATE_DIR/cloudflare_tunnel_domain_tmp" || exit 1
    echo "[✓] 临时隧道进程已启动 (PID: $CF_TMP_PID)，域名: $TMP_DOMAIN"
else
    echo "[!] 未获取到临时隧道域名："
    tail -n 20 "$STATE_DIR/cloudflare_tunnel_tmp.log" 2>/dev/null
fi

# Let the HTTP server generate all protocol/domain/IP links and escape passwords.
echo ""
echo "── 节点链接（含凭据，请勿公开日志）──"
node <<'NODE'
const http = require('node:http');
const request = http.get({ host: '127.0.0.1', port: process.env.PORT, path: `/${process.env.uuid}`, agent: false }, response => {
    response.setEncoding('utf8');
    response.on('data', chunk => process.stdout.write(chunk));
    response.on('end', () => { if (response.statusCode !== 200) process.exitCode = 1; });
});
request.setTimeout(3000, () => request.destroy(new Error('本地链接请求超时')));
request.on('error', error => { console.error(`[!] ${error.message}`); process.exitCode = 1; });
NODE

SUB_DOMAIN=$TMP_DOMAIN
if [ -n "$CF_FIXED_PID" ]; then SUB_DOMAIN=$CLOUDFLARE_TUNNEL_DOMAIN; fi
if [ -n "$SUB_DOMAIN" ]; then
    echo "  节点链接: https://$SUB_DOMAIN/$UUID"
    echo "  Clash 配置: https://$SUB_DOMAIN/$UUID/clash"
fi
echo "[i] 本地启动检查完成；公网可达性请通过客户端验证。"

while true; do
    node_alive
    if [ -n "$CF_FIXED_PID" ] && ! kill -0 "$CF_FIXED_PID" 2>/dev/null; then
        echo "[!] 固定隧道退出，保留临时隧道"
        tail -n 10 "$STATE_DIR/cloudflare_tunnel_fixed.log" 2>/dev/null
        wait "$CF_FIXED_PID" 2>/dev/null || :
        CF_FIXED_PID=""
    fi
    if [ -n "$CF_TMP_PID" ] && ! kill -0 "$CF_TMP_PID" 2>/dev/null; then
        echo "[!] 临时隧道退出，保留固定隧道"
        tail -n 10 "$STATE_DIR/cloudflare_tunnel_tmp.log" 2>/dev/null
        wait "$CF_TMP_PID" 2>/dev/null || :
        CF_TMP_PID=""
    fi
    pause 1
done
