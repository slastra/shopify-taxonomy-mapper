FROM docker.io/oven/bun:1.4.4-slim

# curl for Coolify's container health check (GET /health).
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src

# data/ (taxonomy + SQLite cache) is a persistent volume mounted at /app/data.
ENV NODE_ENV=production
EXPOSE 3001
CMD ["bun", "src/server.ts"]
