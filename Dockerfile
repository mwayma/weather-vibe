FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY . .
# Build the bundle
RUN ./node_modules/.bin/browserify src-radar.js -o radar-bundle.js

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# Copy only what's needed for the runtime
COPY --from=builder /app/server.js ./
COPY --from=builder /app/index.html ./
COPY --from=builder /app/style.css ./
COPY --from=builder /app/app.js ./
COPY --from=builder /app/radar-worker.js ./
COPY --from=builder /app/cities-worker.js ./
COPY --from=builder /app/radar-bundle.js ./
COPY --from=builder /app/data ./data

EXPOSE 80
ENV PORT=80
CMD ["node", "server.js"]
