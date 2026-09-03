# SheetSubmit frontend — standalone SPA (context = ./frontend). No proxy/nginx:
# API base comes from the VITE_API_BASE env var on the web service at container
# start (server.js injects it via /config.js) — nothing is baked into the build.
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --linker=hoisted
COPY . .
RUN bunx tsc -b && bunx vite build

FROM oven/bun:1.3.14
WORKDIR /app
COPY server.js ./
COPY --from=build /app/dist ./dist
EXPOSE 80
CMD ["bun", "server.js"]