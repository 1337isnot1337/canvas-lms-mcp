import packageJson from "../package.json" with { type: "json" };
import { createMcpRelease } from "@canvas-lms-mcp/mcp-core";

export const MCP_RELEASE = createMcpRelease({
  id: "canvas-mcp",
  version: packageJson.version,
  buildId: process.env.MCP_BUILD_ID ?? null,
  commit: process.env.MCP_COMMIT ?? null,
  builtAt: process.env.MCP_BUILT_AT ?? null,
});
