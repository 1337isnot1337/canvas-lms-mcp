import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasRequest, sanitizeCanvasData } from "../src/canvas/http";
import { getConfig } from "../src/config";

afterEach(() => vi.unstubAllGlobals());

describe("Canvas response sanitization", () => {
  it("removes credential-like fields recursively without changing ordinary data", () => {
    expect(
      sanitizeCanvasData({
        id: 123,
        secure_params: "signed-secret",
        nested: {
          Authorization: "Bearer secret",
          title: "Synthetic course",
          rows: [{ refresh_token: "refresh-secret", score: 50 }],
        },
      }),
    ).toEqual({
      id: 123,
      nested: {
        title: "Synthetic course",
        rows: [{ score: 50 }],
      },
    });
  });
});

it("uses the installing user's configuration and blocks writes before fetching", async () => {
  const config = getConfig({
    MCP_URL_SECRET: "test-mcp-key-for-request-validation",
    CANVAS_BASE_URL: "https://canvas.example.edu",
    CANVAS_TOKEN: "test-canvas-token",
  });
  const provider = vi.fn(async (_url: URL, _init: RequestInit) => new Response(
    JSON.stringify([{ id: 123, name: "Synthetic course", access_token: "test-private-field" }]),
    { headers: { "content-type": "application/json" } },
  ));
  vi.stubGlobal("fetch", provider);
  const read = await canvasRequest(config, { path: "/courses" });
  expect(provider.mock.calls[0]?.[0].toString()).toBe("https://canvas.example.edu/api/v1/courses");
  expect(new Headers(provider.mock.calls[0]?.[1].headers).get("authorization")).toBe("Bearer test-canvas-token");
  expect(read.data).toEqual([{ id: 123, name: "Synthetic course" }]);
  const write = await canvasRequest(config, { path: "/courses", method: "POST", body: {} });
  expect(write.status).toBe(403);
  expect(provider).toHaveBeenCalledTimes(1);
  await expect(canvasRequest(config, { path: "https://other.example.org/api/v1/courses" })).rejects.toThrow(/configured Canvas origin/);
  expect(provider).toHaveBeenCalledTimes(1);
});
