FROM oven/bun:latest
WORKDIR /app
COPY package.json package-lock.json ./
RUN bun install --production
COPY . .
EXPOSE 3000
CMD ["bun", "run", "server/index.js"]
