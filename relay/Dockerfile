FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node relay/package.json relay/server.mjs ./
USER node
ENV HOST=0.0.0.0 PORT=8300 NODE_ENV=production
EXPOSE 8300
CMD ["node", "server.mjs"]
