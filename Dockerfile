# Corestone server image: web client built with Node, server built with Go,
# shipped on a minimal Debian base with git (the server drives git plumbing).
#
#   docker build -t corestone .
#   docker run -p 8080:8080 -e CORESTONE_DB=postgres://... -v corestone-data:/data corestone

FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run typecheck && npm run build

FROM golang:1.24-bookworm AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/corestone ./cmd/corestone

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /data --create-home corestone
COPY --from=server /out/corestone /usr/local/bin/corestone
COPY --from=web /src/web/dist /srv/web
ENV CORESTONE_REPO=/data/corestone.git \
    CORESTONE_ADDR=0.0.0.0:8080 \
    CORESTONE_WEB=/srv/web
VOLUME ["/data"]
EXPOSE 8080
USER corestone
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1
ENTRYPOINT ["corestone"]
