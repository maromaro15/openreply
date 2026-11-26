# Facebook Pages / Messenger worker image. Build context is the repo root
# (see docker-compose.yml). It runs raw TypeScript through tsx, so it needs the
# source under lib/ and worker/, tsconfig.json for the "@/*" alias and the
# generated Prisma client.
FROM node:22-slim AS build
WORKDIR /app

# openssl: Prisma's engines look for it on slim images.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# Full install: tsx is a devDependency and is how the worker starts.
RUN npm ci

COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
# prisma generate does not connect; the URL only has to exist.
RUN DATABASE_URL=postgresql://x@127.0.0.1:1/x npx prisma generate

COPY lib ./lib
COPY worker ./worker

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Voice messages are decoded by ffmpeg. lib/ai/audio.ts reads MP4 files whose
# index is at the end through the `cache` protocol, so fail the build if this
# ffmpeg lacks it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -hide_banner -protocols 2>/dev/null | grep -qx '[[:space:]]*cache' \
 && ffmpeg -version | head -n 1

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/app/generated ./app/generated
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts /app/tsconfig.json /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/lib ./lib
COPY --from=build --chown=node:node /app/worker ./worker

USER node
CMD ["npm", "run", "worker:facebook"]
