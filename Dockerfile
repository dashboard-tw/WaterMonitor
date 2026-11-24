FROM node:20-alpine

WORKDIR /app

COPY package.json ./
# 專案無第三方 npm 依賴，無需 npm install，直接複製程式碼
COPY server.js ./
COPY public ./public

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
