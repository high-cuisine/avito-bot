FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY tsconfig.json ./
COPY src/ src/
COPY knowledge/ knowledge/

RUN mkdir -p /app/data

ENV DB_PATH=/app/data/data.db \
    NODE_ENV=production

ENTRYPOINT ["bun", "run", "src/index.ts"]
