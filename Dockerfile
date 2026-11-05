FROM alpine:3.22 AS xray
ARG TARGETARCH
# Fixed release and independently pinned SHA256 for both supported architectures.
RUN apk add --no-cache ca-certificates curl unzip \
    && case "$TARGETARCH" in \
         amd64) asset=64; checksum=e4bd9119f50ae7c41658b1abd0679ae06f98bd864a2907ff33f2f2cf7081b214 ;; \
         arm64) asset=arm64-v8a; checksum=1811c8f1da0c3b6dc707ebaf1c8390e987ba39859a8f0a7aadd8526157f2ec8d ;; \
         *) echo 'Unsupported architecture; use linux/amd64 or linux/arm64' >&2; exit 1 ;; \
       esac \
    && curl --fail --location --retry 3 -o /tmp/xray.zip \
       "https://github.com/XTLS/Xray-core/releases/download/v26.10.31/Xray-linux-${asset}.zip" \
    && printf '%s  /tmp/xray.zip\n' "$checksum" | sha256sum -c - \
    && unzip /tmp/xray.zip xray -d /usr/local/bin \
    && chmod 0755 /usr/local/bin/xray \
    && /usr/local/bin/xray version

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=xray /usr/local/bin/xray /usr/local/bin/xray
COPY --from=xray /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node scripts/ ./scripts/
COPY --chown=node:node package.json start.sh ./
USER node
EXPOSE 8443/tcp
CMD ["sh", "/app/start.sh"]
