#!/bin/sh
set -eu

VERIFY_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERIFY_BINARY=$(realpath -- "${1:?Usage: sh scripts/verify-upstream.sh /path/to/railway-xray-linux-amd64}")
VERIFY_NODE=$(command -v node)

case "$(uname -m)" in
  x86_64) VERIFY_CHECKSUM=bebaa9da6016a55375989abcbe10d2d51123d91ec5465fb033cfc4b7fcc4af72 ;;
  aarch64|arm64) VERIFY_CHECKSUM=efb3c29aeb19bea2c6cc573d44fb550da5357dc72892cc33de72c201a7c9624a ;;
  *) echo 'Only native amd64 and arm64 verification is supported.' >&2; exit 1 ;;
esac

printf '%s  %s\n' "$VERIFY_CHECKSUM" "$VERIFY_BINARY" | sha256sum -c -

# Nothing from the user's home or network is available to the release binary.
# The application and executable are read-only; writable /tmp is disposable.
exec timeout 45s bwrap \
  --unshare-all --die-with-parent --new-session \
  --ro-bind /usr /usr \
  --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin \
  --proc /proc --dev /dev --tmpfs /tmp \
  --dir /app --dir /app/railway-xray \
  --ro-bind "$VERIFY_ROOT/index.js" /app/index.js \
  --ro-bind "$VERIFY_ROOT/railway-xray/gateway.js" /app/railway-xray/gateway.js \
  --ro-bind "$VERIFY_ROOT/railway-xray/backend.js" /app/railway-xray/backend.js \
  --ro-bind "$VERIFY_ROOT/node_modules" /app/node_modules \
  --ro-bind "$VERIFY_BINARY" /backend \
  --ro-bind "$VERIFY_ROOT/scripts/verify-upstream.cjs" /verify.cjs \
  --clearenv --setenv PATH /usr/bin:/bin \
  "$VERIFY_NODE" /verify.cjs
