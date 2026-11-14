FROM node:24.18.0-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3201 \
    KAFCORD_CHAT_DATABASE_PATH=/app/data/kafcord.sqlite \
    KCORD_DOWNLOADS_DIR=/app/downloads

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
COPY --chown=node:node dist ./dist

RUN mkdir -p /app/data /app/uploads /app/downloads \
    && chown -R node:node /app

USER node

EXPOSE 3201

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3201/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "node_modules/tsx/dist/cli.mjs", "server/index.ts"]
