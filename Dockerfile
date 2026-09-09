# better-sqlite3 네이티브 빌드 때문에 nixpacks 자동감지보다 Dockerfile이 안전하다.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 컴파일에 필요 (prebuild가 없을 때 대비)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build

# corp_code sqlite 캐시 위치 (컨테이너 재시작 시 재다운로드)
ENV CORP_CODE_CACHE_DIR=/tmp/korean-dart-mcp
ENV PORT=8080
EXPOSE 8080

CMD ["node", "build/http.js"]
