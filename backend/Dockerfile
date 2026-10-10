FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

ENV PORT=5000
EXPOSE 5000

CMD ["node", "server.js"]
