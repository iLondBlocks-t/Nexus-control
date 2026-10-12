# NEXUS control server.
#
# Nothing is baked into this image: no API key, no owner token, no URL. Every
# setting comes from the environment at run time, which is what lets the same
# image run on a laptop, a VPS or a managed container host.
#
# Build:  docker build -t nexus-control .
# Run:    docker run --env-file .env -p 3000:3000 nexus-control

FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LOG_FORMAT=json

WORKDIR /app

# Dependencies first: this layer is cached until package files change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ ./server/
COPY scripts/ ./scripts/
COPY package.json ./

# Written at run time by the storage driver (./data). Owned by the node user.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
