# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/src/core ./src/core
COPY --from=build --chown=node:node /app/scripts/lib/audit-config.ts ./scripts/lib/audit-config.ts
COPY --from=build --chown=node:node /app/scripts/lib/vision-audit.ts ./scripts/lib/vision-audit.ts
USER node
EXPOSE 8080
CMD ["npm", "start"]
