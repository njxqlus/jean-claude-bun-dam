FROM oven/bun:1.3.12

RUN apt-get update \
  && apt-get install -y --no-install-recommends imagemagick ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY . .

CMD ["bun", "run", "src/index.ts"]
