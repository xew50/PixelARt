# PixelFace AI — прод-образ без зависимостей
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json server.mjs ./
COPY public ./public

# контейнер не должен работать от root
USER node

EXPOSE 3000
ENV PORT=3000
ENV HOST=0.0.0.0

CMD ["node", "server.mjs"]
