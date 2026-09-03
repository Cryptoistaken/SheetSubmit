# SheetSubmit backend — Express API image (standalone, context = ./backend).
FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile --linker=hoisted

FROM oven/bun:1.3.14 AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules /app/node_modules
COPY package.json bun.lock ./
COPY src ./src
USER bun
ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
