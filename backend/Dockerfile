FROM node:22-alpine

WORKDIR /app

# better-sqlite3 needs a compiler at install time
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=5000
EXPOSE 5000

CMD ["node", "server.js"]
