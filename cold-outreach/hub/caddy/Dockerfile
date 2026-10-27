# Builds the React app, then serves it with Caddy (HTTPS + /api proxy).
FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM caddy:2.8.4-alpine
COPY caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=frontend /build/dist /srv
