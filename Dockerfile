FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY . .
# Build the bundle. In this setup, browserify is installed in devDependencies.
RUN ./node_modules/.bin/browserify src-radar.js -o radar-bundle.js

FROM nginx:alpine
# Copy static files to nginx serving directory
COPY --from=builder /app/index.html /usr/share/nginx/html/
COPY --from=builder /app/style.css /usr/share/nginx/html/
COPY --from=builder /app/app.js /usr/share/nginx/html/
COPY --from=builder /app/radar-worker.js /usr/share/nginx/html/
COPY --from=builder /app/cities-worker.js /usr/share/nginx/html/
COPY --from=builder /app/radar-bundle.js /usr/share/nginx/html/
COPY --from=builder /app/data /usr/share/nginx/html/data

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
