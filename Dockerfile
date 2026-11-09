FROM node:22-bookworm-slim

ARG TARGETARCH

# Debian supplies the glibc runtime required by the optional Rust backend.
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) checksum=bebaa9da6016a55375989abcbe10d2d51123d91ec5465fb033cfc4b7fcc4af72 ;; \
      arm64) checksum=efb3c29aeb19bea2c6cc573d44fb550da5357dc72892cc33de72c201a7c9624a ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl libgcc-s1; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 120 \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$TARGETARCH" \
      -o /usr/local/bin/cloudflared; \
    curl -fSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 120 \
      "https://github.com/ryotwell/railway-xray/releases/download/v0.1.4/railway-xray-linux-$TARGETARCH" \
      -o /usr/local/bin/railway-xray; \
    echo "$checksum  /usr/local/bin/railway-xray" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/cloudflared /usr/local/bin/railway-xray

WORKDIR /app
ENV NODE_ENV=production PROXY_BACKEND=node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --chown=node:node index.js start.sh result.csv ./
COPY --chown=node:node railway-xray/ ./railway-xray/

USER node
EXPOSE 8080
CMD ["sh", "start.sh"]
