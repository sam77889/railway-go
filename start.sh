#!/bin/sh
set -eu
umask 077

# The Compose tmpfs is writable only by this container's non-root user.
node /app/scripts/manage.js server /run/xray/config.json
if ! xray run -test -config /run/xray/config.json >/dev/null 2>&1; then
    echo 'Xray configuration validation failed; refusing to start.' >&2
    exit 1
fi

echo 'Configuration validated; starting Xray.'
# Xray receives stop signals directly; no background process or shell supervisor.
exec xray run -config /run/xray/config.json
