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

# Production dependencies only.
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
CMD ["node", "dist/main.js"]