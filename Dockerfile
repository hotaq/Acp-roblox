FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node server.js store.js ./
COPY --chown=node:node public ./public
ENV HOST=0.0.0.0 PORT=4317
EXPOSE 4317
USER node
CMD ["node", "server.js"]
