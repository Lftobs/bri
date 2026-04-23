FROM oven/bun:1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    docker.io \
    bash \
    unzip \
    tar \
    && rm -rf /var/lib/apt/lists/*

RUN command -v docker || command -v docker.io

RUN curl -sSL https://railpack.com/install.sh | sh -s -- --bin-dir /usr/local/bin

RUN docker buildx install-plugin || true

WORKDIR /app

COPY package.json ./
RUN bun install

COPY src ./src

RUN mkdir -p /app/data /app/workspace /caddy/routes

EXPOSE 3001

CMD ["bun", "src/index.ts"]
