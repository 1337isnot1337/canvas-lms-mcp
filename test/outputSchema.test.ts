import { describe, expect, it } from "vitest";
import { getMcpToolDefinitions } from "@canvas-lms-mcp/mcp-core";
import { createCanvasMcpServer } from "../src/mcp";
import type { RuntimeConfig } from "../src/config";
import { TOP_30_TOOLS } from "../src/canvas/top30";

type ToolDefinition = {
  outputSchema?: { safeParse(value: unknown): { success: boolean } };
  handler: (...args: any[]) => Promise<any>;
};

type ToolRegistry = Record<
  string,
  ToolDefinition
>;

const config: RuntimeConfig = {
  mcpUrlSecret: "abcdefghijklmnopqrstuvwxyz123456",
  canvasBaseUrl: "https://canvas.example.edu",
  canvasOrigin: "https://canvas.example.edu",
  canvasToken: "test-canvas-token",
  canvasUserAgent: "CanvasMCP/Test",
  canvasAccept: "application/json",
  canvasAcceptLanguage: "en-US",
  readOnly: true,
  maxApiResponseBytes: 1000,
  maxFileBytes: 1000,
  maxTextChars: 1000,
};

function tools(): ToolRegistry {
  return Object.fromEntries(
    getMcpToolDefinitions(createCanvasMcpServer(config)).map((tool) => [tool.name, tool]),
  ) as ToolRegistry;
}

describe("Canvas MCP output schemas", () => {
  it("attaches an outputSchema to every registered tool", () => {
    const registered = tools();
    expect(Object.keys(registered).length).toBe(12 + TOP_30_TOOLS.length);
    for (const [name, tool] of Object.entries(registered)) {
      expect(tool.outputSchema, name).toBeDefined();
    }
  });

  it("returns status structuredContent matching its outputSchema", async () => {
    const registered = tools();
    const tool = registered.get_canvas_mcp_status;
    expect(tool).toBeDefined();
    const result = await tool!.handler({}, {});
    expect(result.structuredContent).toMatchObject({ ok: true });
    expect(tool!.outputSchema?.safeParse(result.structuredContent).success).toBe(true);
  });
});
