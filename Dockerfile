FROM oven/bun:1 AS builder

WORKDIR /build

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY tsconfig.json ./
COPY src/ src/

RUN bun build src/index.ts --compile --outfile=avito-bot

# ─── Runtime ──────────────────────────────────────────────────────────────────

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /build/avito-bot .

RUN mkdir -p /app/data

ENV DB_PATH=/app/data/data.db

ENTRYPOINT ["./avito-bot"]
