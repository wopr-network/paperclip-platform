FROM node:lts-trixie-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build
RUN test -f dist/index.js || (echo "ERROR: build output missing" && exit 1)

FROM base AS production
WORKDIR /app
COPY --chown=node:node --from=deps /app/node_modules /app/node_modules
COPY --chown=node:node --from=build /app/dist /app/dist
COPY --chown=node:node --from=build /app/package.json /app/package.json

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3200

# Injected at runtime by fleet / docker-compose:
#   PROVISION_SECRET  — shared secret for /internal/* and provision webhook
#   GATEWAY_URL       — platform-core inference gateway URL
#   PLATFORM_DOMAIN   — e.g. runpaperclip.ai
#   UI_ORIGIN         — CORS origin for dashboard
#   DATABASE_URL      — Postgres (optional)

EXPOSE 3200

USER node
CMD ["node", "dist/index.js"]
