# Multi-stage build for the wallet API.
# Keeps the runtime image small (no dev deps, no build toolchain) and runs as
# a non-root user.

FROM node:22-alpine AS build
WORKDIR /app

# Install dependencies from the lockfile for a reproducible build.
COPY package*.json ./
RUN npm ci

# Build the TypeScript output.
COPY prisma ./prisma
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npx prisma generate && npm run build


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only. The Prisma CLI is a runtime dependency here
# because migrations run at container start.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Generated Prisma client + schema (needed to run migrations at boot).
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY prisma ./prisma
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000

# The app binds to 0.0.0.0 so the platform's router can reach it.
ENV PORT=3000

# Migrations and the idempotent demo seed run at container start. Render's
# free tier has no shell, so this is the only place they can run.
#
# `migrate deploy` takes a Postgres advisory lock with a 10s timeout. When the
# database is cold (a managed Postgres that suspends after inactivity) that
# lock can time out and kill the container, so we retry it before giving up.
# The app starts regardless: a transient migrate failure should degrade, not
# take the service down.
CMD ["sh", "-c", "for i in 1 2 3 4 5; do npx prisma migrate deploy && break; echo 'migrate failed, retrying...'; sleep 8; done; node dist/prisma/seed.js; node dist/src/main.js"]