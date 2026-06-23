FROM node:20-slim

RUN apt-get update && apt-get install -y \
  tesseract-ocr \
  poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY heb_rashi.traineddata /usr/share/tesseract-ocr/5/tessdata/heb_rashi.traineddata

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js index.html ./

EXPOSE 3333

CMD ["node", "server.js"]
