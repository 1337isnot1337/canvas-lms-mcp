FROM node:24-bookworm-slim
ARG MCP_BUILD_ID=development
ARG MCP_COMMIT=unknown
ARG MCP_BUILT_AT=unknown
LABEL org.opencontainers.image.title="Canvas LMS MCP" \
      org.opencontainers.image.revision="${MCP_COMMIT}"
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages/mcp-core/package.json ./packages/mcp-core/package.json
COPY --chown=node:node packages/mcp-http-node/package.json ./packages/mcp-http-node/package.json
COPY --chown=node:node relay/package.json ./relay/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node packages ./packages
COPY --chown=node:node src ./src
USER node
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production \
    MCP_BUILD_ID=${MCP_BUILD_ID} MCP_COMMIT=${MCP_COMMIT} MCP_BUILT_AT=${MCP_BUILT_AT}
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
