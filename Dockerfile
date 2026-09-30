FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache su-exec
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p var && chown node:node var
ENV PORT=3000 TRUST_PROXY=1
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
# A mounted disk (LOG_DIR) arrives owned by root: hand it to the node user, then run the server as node, never as root.
CMD ["sh", "-c", "if [ -n \"$LOG_DIR\" ]; then mkdir -p \"$LOG_DIR\" && chown -R node:node \"$LOG_DIR\"; fi; exec su-exec node node server/server.js"]
