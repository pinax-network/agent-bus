FROM oven/bun:1.3.11-slim

WORKDIR /app

# Install deps first for layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

# The SQLite file lives here — mount a volume to persist it across restarts.
ENV AGENT_BUS_DB=/data/agent-bus.db
VOLUME ["/data"]

EXPOSE 7077

# AGENT_BUS_TOKEN must be supplied at runtime (the server refuses to start without
# it unless AGENT_BUS_ALLOW_NO_AUTH=1). HEALTHCHECK hits the unauthenticated /health.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||7077)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
