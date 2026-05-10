FROM node:20-alpine
WORKDIR /app

COPY package.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/bot/package.json ./apps/bot/

RUN npm install --omit=dev --workspaces --include-workspace-root

COPY packages/core/ ./packages/core/
COPY apps/bot/ ./apps/bot/

WORKDIR /app/apps/bot
EXPOSE 3007
CMD ["node", "server.js"]
