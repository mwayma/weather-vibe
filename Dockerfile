FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application files
COPY server.js ./
COPY index.html ./
COPY style.css ./
COPY app.js ./
COPY cities-worker.js ./
COPY data ./data

EXPOSE 80
ENV PORT=80

CMD ["node", "server.js"]
