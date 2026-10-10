import { describe, expect, it } from "vitest";
import { getConfig, normalizeCanvasBaseUrl } from "../src/config";

const env = {
  MCP_URL_SECRET: "test-mcp-key-for-synthetic-config",
  CANVAS_BASE_URL: "https://canvas.example.edu",
  CANVAS_TOKEN: "test-canvas-token",
};

describe("self-hosted configuration", () => {
  it("defaults to read-only and requires independent credentials", () => {
    expect(getConfig(env).readOnly).toBe(true);
    expect(() => getConfig({ ...env, CANVAS_TOKEN: "" })).toThrow(/CANVAS_TOKEN/);
    expect(() => getConfig({ ...env, MCP_URL_SECRET: "short" })).toThrow(/MCP_URL_SECRET/);
    expect(() => getConfig({ ...env, MCP_URL_SECRET: " ".repeat(30) })).toThrow(/MCP_URL_SECRET/);
  });

  it("rejects credential-bearing URLs and unrelated Canvas paths", () => {
    for (const url of [
      "http://canvas.example.edu",
      "https://user:password@canvas.example.edu",
      "https://canvas.example.edu/?token=test",
      "https://canvas.example.edu/#private",
      "https://canvas.example.edu/courses",
    ]) expect(() => normalizeCanvasBaseUrl(url)).toThrow();
    expect(normalizeCanvasBaseUrl("https://canvas.example.edu/api/v1/")).toBe(env.CANVAS_BASE_URL);
  });

  it("rejects ambiguous booleans and malformed limits", () => {
    expect(() => getConfig({ ...env, READ_ONLY: "tru" })).toThrow(/Boolean/);
    expect(getConfig({ ...env, READ_ONLY: "false" }).readOnly).toBe(false);
    for (const value of ["0", "-1", "100bytes", "1.5"]) {
      expect(() => getConfig({ ...env, MAX_FILE_BYTES: value })).toThrow(/positive integers/);
    }
  });

  it("requires a complete HTTPS relay configuration", () => {
    expect(() => getConfig({ ...env, CANVAS_RELAY_URL: "https://relay.example.org" })).toThrow(/together/);
    expect(() => getConfig({ ...env, CANVAS_RELAY_URL: "https://relay.example.org", CANVAS_RELAY_SECRET: "short" })).toThrow(/32/);
    expect(getConfig({ ...env, CANVAS_TOKEN: "", CANVAS_RELAY_URL: "https://relay.example.org", CANVAS_RELAY_SECRET: "test-relay-key-for-synthetic-config" }).canvasRelay?.url).toBe("https://relay.example.org");
  });
});
