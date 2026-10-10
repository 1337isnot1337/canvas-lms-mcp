import { mcpResult } from "@canvas-lms-mcp/mcp-core";

export const jsonText = mcpResult;

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
