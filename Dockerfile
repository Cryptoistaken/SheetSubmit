FROM oven/bun:1.3.14
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY . .
USER bun
EXPOSE 3000
CMD ["bun", "run", "server/index.js"]
