FROM node:22.13-bookworm-slim
ENV NODE_ENV=production PORT=8787 AMB_CP_DB=/data/control-plane.sqlite AMB_CP_TRUST_PROXY=1
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.mjs ./server.mjs
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "server.mjs"]
