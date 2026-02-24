FROM node:22-slim

WORKDIR /app

COPY package.json ./
COPY app.js ./
COPY static/ ./static/

EXPOSE 3000

CMD ["node", "app.js"]
