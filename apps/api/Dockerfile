# Build (toolchain para módulos nativos como argon2)
FROM node:24.19.0-bookworm AS build
RUN npm install --global pnpm@9.15.9
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sdr/config --filter @sdr/core --filter @sdr/db --filter @sdr/api build

# Runtime
FROM node:24.19.0-bookworm-slim AS runtime
RUN npm install --global pnpm@9.15.9
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
EXPOSE 3001
CMD ["node", "dist/main.js"]
