# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY nest-cli.json tsconfig*.json ./
COPY src ./src
RUN npm run build:prod \
  && npm prune --omit=dev --omit=optional --no-audit --no-fund \
  && npm cache clean --force

FROM node:20-alpine AS production
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=48300

RUN addgroup -S appgroup \
  && adduser -S appuser -G appgroup

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

RUN mkdir -p /app/uploads /app/logs \
  && chown -R appuser:appgroup /app

USER appuser
EXPOSE 48300

CMD ["node", "dist/main.js"]
