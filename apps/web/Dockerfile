FROM node:24.19.0-bookworm AS build
RUN npm install --global pnpm@9.15.9
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN pnpm --filter @sdr/web build

FROM node:24.19.0-bookworm-slim AS runtime
RUN npm install --global pnpm@9.15.9
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/apps/web
EXPOSE 3000
CMD ["pnpm", "start"]
