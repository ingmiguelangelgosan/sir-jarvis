FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS production-dependencies
WORKDIR /dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS runtime
ENV NODE_ENV=production JARVIS_AI_MODE=disabled JARVIS_HEALTH_FILE=/tmp/jarvis-health
WORKDIR /app
COPY --from=build --chown=node:node /build/dist ./dist
COPY --from=production-dependencies --chown=node:node /dependencies/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node deploy/healthcheck.mjs ./healthcheck.mjs
RUN mkdir -p /data/state /data/runtime /backups /recovery && chown -R node:node /data /backups /recovery && chmod 0700 /data /data/state /data/runtime /backups /recovery
USER node
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "/app/healthcheck.mjs"]
CMD ["node", "dist/app/telegram-main.js"]
