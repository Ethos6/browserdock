FROM node:26-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM mcr.microsoft.com/playwright:v1.64.1-noble AS runtime

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    BROWSERDOCK_HOST=0.0.0.0 \
    BROWSERDOCK_PORT=3000

WORKDIR /app
COPY --from=build --chown=pwuser:pwuser /app/package.json ./package.json
COPY --from=build --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=build --chown=pwuser:pwuser /app/dist ./dist

USER pwuser
EXPOSE 3000
ENTRYPOINT ["node", "dist/src/server.js"]
