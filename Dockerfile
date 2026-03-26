FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY bin/ bin/
COPY src/ src/
COPY tsconfig.json .

ENV CCC_PORT=3337
ENV CCC_HOST=0.0.0.0
ENV CCC_DB_PATH=/data/server.db

EXPOSE 3337

CMD ["bun", "run", "bin/ccc.ts", "server"]
