FROM alpine:3.21

# Node runtime only — no npm or build tools needed (zero dependencies).
RUN apk add --no-cache nodejs ca-certificates tzdata

WORKDIR /app
COPY package.json server.js ./
COPY src ./src

USER nobody

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    LOG_FORMAT=json \
    ENV_FILE=none

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["node", "server.js"]
