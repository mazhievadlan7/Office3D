# Office3D - 3D agent visualization for OpenClaw.
# Multi-stage build: install prod deps -> build Next.js -> run with custom server.

# Node 22 (Active LTS). Node 20 went end-of-life in April 2026, and vite 8 /
# rolldown require ^20.19 || >=22.12, so 22 is both the supported and the
# maintained floor.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev

FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time gateway URL (overridden at runtime by OFFICE3D_GATEWAY_URL).
ENV NEXT_PUBLIC_GATEWAY_URL=ws://127.0.0.1:18789
RUN npm run build

# Hermes updates (the office3d-updater service): the only container that gets
# the Docker socket. Node plus the static Docker CLI and compose plugin, and
# nothing of the app but the updater itself. Kept before `runner`, so a plain
# build still produces the office image.
FROM node:22-alpine AS updater
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:27-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
WORKDIR /app
COPY server/updater ./server/updater
ENV UPDATER_PORT=3020
EXPOSE 3020
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3020/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/updater/index.js"]

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# The server binds 127.0.0.1 by default, which is unreachable from outside the
# container. Binding a public host is refused unless STUDIO_ACCESS_TOKEN is set
# (see server/network-policy.js), so that must be supplied at run time.
ENV HOST=0.0.0.0
ENV PORT=3000

# Settings, uploads and the task store live here. Mount a volume on it to keep
# them across container replacements.
ENV OPENCLAW_STATE_DIR=/data

# Copy built app + custom server + production node_modules only.
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/server ./server
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts

# Run unprivileged. The node image ships a `node` user (uid 1000); it owns the
# state directory so the app can write to the mounted volume.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
