# syntax=docker/dockerfile:1.7
# Multi-stage build producing three images from one codebase:
#   --target web      Next.js dashboard + REST API (standalone output)
#   --target worker   BullMQ monitoring workers (also runs `prisma migrate deploy`)
#   --target scanner  isolated OWASP ZAP scan worker (no database access)

FROM node:22-alpine AS base
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV BUILD_STANDALONE=1
RUN npx prisma generate \
 && npm run build \
 && npm run build:worker \
 && npm run build:scanner

# ─── Web ───
FROM base AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "server.js"]

# ─── Worker ───
FROM base AS worker
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist-worker ./dist-worker
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
CMD ["node", "dist-worker/index.js"]

# ─── Scanner (OWASP ZAP + isolated scan runner) ───
FROM node:22-bookworm-slim AS scanner-deps
WORKDIR /deps
COPY deploy/scanner/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts

FROM ghcr.io/zaproxy/zaproxy:stable AS scanner
USER root
# Node.js runtime copied from the official image (single binary, glibc-based like the ZAP image).
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /zap/scanner
COPY --from=scanner-deps --chown=zap:zap /deps/node_modules ./node_modules
COPY --from=build --chown=zap:zap /app/dist-scanner ./dist-scanner
USER zap
ENV NODE_ENV=production ZAP_COMMAND=zap.sh
CMD ["node", "dist-scanner/index.js"]
