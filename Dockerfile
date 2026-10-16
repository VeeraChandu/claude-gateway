FROM alpine:3.21

# Install only nodejs runtime (no npm, corepack, or build tools)
RUN apk add --no-cache nodejs ca-certificates tzdata && \
    rm -rf /var/cache/apk/*

WORKDIR /app

# Copy source code (zero external dependencies needed)
COPY config.js translator.js server.js package.json ./

# Run as non-root user for security
USER nobody

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

ENTRYPOINT ["node", "server.js"]
