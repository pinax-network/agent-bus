FROM oven/bun:1.3.11-slim

WORKDIR /app

# Install deps first for layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY skills ./skills
COPY web ./web
# The release-watcher reads this at startup (when AGENT_BUS_WATCH=1).
COPY watchlist.json ./watchlist.json

# SQLite lives here. On Railway, attach a Volume mounted at /data to persist the
# bus across redeploys (otherwise state resets each deploy — agents just
# re-register, so it's not fatal, but claims/messages are lost).
ENV AGENT_BUS_DB=/data/agent-bus.db

# Railway injects PORT at runtime; the server reads it. 7077 is the local default.
EXPOSE 7077

CMD ["bun", "run", "src/index.ts"]
