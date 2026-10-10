import {
  createMcpAuthenticator,
  createMcpHttpRuntime,
  registerMcpHealthRoutes,
} from "@canvas-lms-mcp/mcp-http-node";
import type { NextFunction, Request, Response } from "express";
import { getConfig, type CanvasEnv } from "./config";
import { sanitizedCanvasHeaders } from "./canvas/http";
import { createCanvasMcpServer } from "./mcp";
import { CANVAS_TOOL_ALIASES } from "./canvas/top30";
import { canvasRelayHealth } from "./canvas/relay";
import { environmentWithSecretFiles } from "./env";
import { MCP_RELEASE } from "./release";

const host = process.env.HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PORT || "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}
const runtimeEnv = environmentWithSecretFiles(["MCP_URL_SECRET", "CANVAS_TOKEN", "CANVAS_RELAY_SECRET"]);
const config = getConfig(runtimeEnv as unknown as CanvasEnv);
const authenticate = createMcpAuthenticator({
  token: config.mcpUrlSecret,
  querySecret: config.mcpUrlSecret,
  allowQueryKey: process.env.MCP_ALLOW_QUERY_KEY?.trim().toLowerCase() === "true",
});
const runtime = createMcpHttpRuntime({
  metadata: { ...MCP_RELEASE, readOnly: config.readOnly },
  host,
  maxRequestBytes: process.env.MAX_REQUEST_BYTES || "2mb",
  authenticate,
  toolAliases: CANVAS_TOOL_ALIASES,
  createServer: () => createCanvasMcpServer(config),
});
const { app } = runtime;

registerMcpHealthRoutes(app, MCP_RELEASE);

app.get(["/", "/health"], async (request: Request, response: Response, next: NextFunction) => {
  try {
    if (!(await authenticate(request))) {
      response.status(401).type("text/plain").send("Unauthorized");
      return;
    }
    response.status(200).json({
      ok: true,
      service: MCP_RELEASE.id,
      version: MCP_RELEASE.version,
      build_id: MCP_RELEASE.buildId,
      canvas_base_url: config.canvasBaseUrl,
      canvas_request_headers: sanitizedCanvasHeaders(config),
      canvas_relay_configured: Boolean(config.canvasRelay),
      canvas_transport: config.canvasRelay ? "relay" : "direct",
      read_only: config.readOnly,
      mcp_endpoint: "/mcp",
    });
  } catch (error) {
    next(error);
  }
});

app.use(runtime.notFoundHandler);
app.use(runtime.errorHandler);

const listener = runtime.listen(port, () => {
  console.log(`canvas-mcp listening on ${host}:${port}`);
});

let relayTimer: ReturnType<typeof setInterval> | undefined;
if (config.canvasRelay) {
  relayTimer = setInterval(() => {
    void canvasRelayHealth(config).then((ok) => {
      if (!ok) console.error("Canvas relay health check failed.");
    });
  }, 30 * 60 * 1000);
  relayTimer.unref();
}

function shutdown(signal: string): void {
  console.log(`Received ${signal}; shutting down.`);
  if (relayTimer) clearInterval(relayTimer);
  listener.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
