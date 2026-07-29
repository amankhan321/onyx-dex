# FlowBot — Telegram bot service.
#
# The bot holds NO keys: it builds unsigned transactions and the Mini App signs
# them on the user's device. What it does hold is the Telegram token, which is
# why that value is injected at deploy time from a GitHub secret and never
# baked into this image or committed to the repo.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 compiles a native module, so the build stage needs a toolchain.
# It is discarded — the runtime image carries only the compiled artefact.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
# initDb() reads schema.sql relative to __dirname; tsc doesn't copy non-TS files.
COPY src/db/schema.sql ./dist/db/schema.sql
# Writable location for the SQLite file, owned by the unprivileged user.
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "dist/bot/index.js"]
