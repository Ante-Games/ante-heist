FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY game ./game
ENV NODE_ENV=production
CMD ["node", "game/src/server.ts"]
