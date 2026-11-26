# web: one Node process serves the built storefront (dist/) and the API on :8080.
# Talks to PostgreSQL + OpenSearch only; never Kafka (checkout writes to the outbox).
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY tsconfig.json vite.config.ts ./
COPY web ./web
COPY server ./server
RUN npm run build

# Meaning search (doc/19): bake the small embedding model into the image, so nothing is
# downloaded while serving. If this step ever fails, search still works (keywords only).
ENV MODEL_DIR=/app/.models
COPY scripts/fetch-model.ts ./scripts/fetch-model.ts
RUN npx tsx scripts/fetch-model.ts && chown -R node /app/.models

ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "--import", "tsx", "server/main.ts"]
