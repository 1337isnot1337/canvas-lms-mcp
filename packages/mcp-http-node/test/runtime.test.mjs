import assert from "node:assert/strict";
import test from "node:test";
import { createBaseMcpServer } from "../../mcp-core/src/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createMcpAuthenticator,
  createMcpHttpRuntime,
  registerMcpHealthRoutes,
} from "../src/index.js";

async function startRuntime(runtimeOptions = {}) {
  const authenticate = createMcpAuthenticator({ token: "test-secret" });
  const runtime = createMcpHttpRuntime({
    metadata: {
      id: "http-contract-mcp",
      version: "1.2.3",
      buildId: "http-build",
      lastUpdatedAt: "2000-01-02T12:34:56.000Z",
    },
    host: "127.0.0.1",
    ...runtimeOptions,
    authenticate,
    createServer: () => createBaseMcpServer({
      id: "http-contract-mcp",
      version: "1.2.3",
      lastUpdatedAt: "2000-01-02T12:34:56.000Z",
    }),
  });
  registerMcpHealthRoutes(runtime.app, {
    id: "http-contract-mcp",
    version: "1.2.3",
    buildId: "http-build",
    lastUpdatedAt: "2000-01-02T12:34:56.000Z",
  });
  runtime.app.use(runtime.notFoundHandler);
  runtime.app.use(runtime.errorHandler);
  const listener = await new Promise((resolve) => {
    const server = runtime.listen(0, () => resolve(server));
  });
  const address = listener.address();
  return { runtime, listener, baseUrl: `http://127.0.0.1:${address.port}` };
}

test("the shared HTTP runtime standardizes health, auth, and method handling", async () => {
  const { listener, baseUrl } = await startRuntime();
  try {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      schema_version: 1,
      service: "http-contract-mcp",
      version: "1.2.3",
      build_id: "http-build",
      last_updated_at: "2000-01-02T12:34:56.000Z",
      last_updated_human: "Sunday, January 2, 2000 at 12:34:56 PM UTC",
      last_updated_unix: 946816496,
      last_updated_source: "release_metadata",
      read_only: null,
    });
    assert.match(health.headers.get("x-request-id") ?? "", /^[A-Za-z0-9._:-]{1,128}$/);
    const ready = await fetch(`${baseUrl}/readyz`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).ok, true);

    const unauthorized = await fetch(`${baseUrl}/mcp`, { method: "GET" });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get("x-request-id") ?? "", /^[A-Za-z0-9._:-]{1,128}$/);

    const wrongMethod = await fetch(`${baseUrl}/mcp`, {
      headers: { "x-mcp-key": "test-secret" },
    });
    assert.equal(wrongMethod.status, 405);

    const wrongContentType = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "x-mcp-key": "test-secret", "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongContentType.status, 415);

    const client = new Client({ name: "http-contract-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { "x-mcp-key": "test-secret" } },
    });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["get_version", "get_capabilities"]);
    const version = await client.callTool({ name: "get_version", arguments: {} });
    assert.deepEqual(version.structuredContent, {
      ok: true,
      schema_version: 2,
      service: "http-contract-mcp",
      version: "1.2.3",
      build_id: null,
      commit: null,
      built_at: null,
      manifest_hash: version.structuredContent.manifest_hash,
      tool_manifest_sha256: version.structuredContent.tool_manifest_sha256,
      connector_metadata_sha256: version.structuredContent.connector_metadata_sha256,
      last_updated_at: "2000-01-02T12:34:56.000Z",
      last_updated_human: "Sunday, January 2, 2000 at 12:34:56 PM UTC",
      last_updated_unix: 946816496,
      last_updated_source: "release_metadata",
      read_only: false,
      tool_count: 2,
      framework: {
        name: "@canvas-lms-mcp/mcp-core",
        version: "0.2.0",
        contract_version: 2,
      },
    });
    assert.match(version.structuredContent.manifest_hash, /^[a-f0-9]{64}$/);
    assert.match(version.structuredContent.tool_manifest_sha256, /^[a-f0-9]{64}$/);
    assert.match(version.structuredContent.connector_metadata_sha256, /^[a-f0-9]{64}$/);
    await client.close();
  } finally {
    await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  }
});

test("browser origins and query credentials require explicit configuration", async () => {
  const authenticate = createMcpAuthenticator({ token: "test-secret", querySecret: "test-secret", allowQueryKey: false });
  assert.equal(authenticate({ url: "/mcp?key=test-secret", headers: {} }), false);
  assert.equal(authenticate({ url: "/mcp", headers: { authorization: "Bearer test-secret" } }), true);
  const { listener, baseUrl } = await startRuntime();
  try {
    const rejected = await fetch(`${baseUrl}/mcp`, {
      headers: { origin: "https://untrusted.example.org", authorization: "Bearer test-secret" },
    });
    assert.equal(rejected.status, 403);
    const unauthorized = await fetch(`${baseUrl}/mcp?key=test-secret`);
    assert.equal(unauthorized.status, 401);
    const authenticated = await fetch(`${baseUrl}/mcp`, {
      headers: { authorization: "Bearer test-secret" },
    });
    assert.equal(authenticated.status, 405);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});

test("query-key authentication accepts exactly one canonical public key", () => {
  const authenticate = createMcpAuthenticator({
    querySecret: "test-secret",
    allowQueryKey: true,
  });
  const request = (url) => ({ url, headers: {} });
  assert.equal(authenticate(request("/mcp?key=test-secret")), true);
  assert.equal(authenticate(request("/mcp?key=wrong")), false);
  assert.equal(authenticate(request("/mcp?key=test-secret&key=test-secret")), false);
});

test("optionally accepts JSON-only MCP clients with a JSON response", async () => {
  const { listener, baseUrl } = await startRuntime({ allowJsonOnlyAccept: true });
  try {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "x-mcp-key": "test-secret",
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "json-only-client", version: "1.0.0" },
        },
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal((await response.json()).result.serverInfo.name, "http-contract-mcp");
  } finally {
    await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  }
});
