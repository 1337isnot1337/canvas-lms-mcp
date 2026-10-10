import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  createBaseMcpServer,
  getMcpLastUpdated,
  getMcpToolCatalog,
  getMcpToolContracts,
  getMcpToolDefinitions,
  mcpResult,
  registerMcpTool,
  runMcpRequestContext,
  setMcpToolOutputSchemas,
} from "../src/index.js";

test("every base server exposes the standard version and capability contract", async () => {
  const server = createBaseMcpServer({
    id: "contract-test-mcp",
    version: "9.8.7",
    buildId: "contract-build",
    commit: "abc123",
    builtAt: "2000-01-01T00:00:00.000Z",
    lastUpdatedAt: "2000-01-02T12:34:56.000Z",
    readOnly: true,
    description: "A contract-test connector for validating discovery behavior.",
    useWhen: ["testing MCP discovery and tool contracts"],
    notFor: ["production data"],
    relatedServices: ["none"],
    routingNotes: ["Prefer this connector only for contract tests."],
  });
  registerMcpTool(
    server,
    "echo",
    {
      description: "Echo a value for contract testing.",
      inputSchema: { value: z.string() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ value }) => mcpResult({ ok: true, value }),
  );
  setMcpToolOutputSchemas(server, {
    echo: z.object({ ok: z.literal(true), value: z.string() }),
  });

  const definitions = getMcpToolDefinitions(server);
  assert.deepEqual(
    definitions.map((tool) => tool.name),
    ["get_version", "get_capabilities", "echo"],
  );
  assert.ok(definitions.every((tool) => tool.outputSchema));
  assert.deepEqual(
    getMcpToolCatalog(server).map((tool) => tool.name),
    ["get_version", "get_capabilities", "echo"],
  );
  const echoContract = getMcpToolContracts(server).find((tool) => tool.name === "echo");
  assert.equal(echoContract.input_schema.properties.value.description, "Value for value used by echo.");
  assert.equal(echoContract.output_schema.properties.ok.const, true);
  assert.deepEqual(getMcpLastUpdated({ builtAt: "not-a-timestamp" }), {
    last_updated_at: null,
    last_updated_human: "Unknown — no valid release or build timestamp was supplied.",
    last_updated_unix: null,
    last_updated_source: "unavailable",
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract-test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ["get_version", "get_capabilities", "echo"],
  );

  const version = await client.callTool({ name: "get_version", arguments: {} });
  assert.deepEqual(version.structuredContent, {
    ok: true,
    schema_version: 2,
    service: "contract-test-mcp",
    version: "9.8.7",
    build_id: "contract-build",
    commit: "abc123",
    built_at: "2000-01-01T00:00:00.000Z",
    manifest_hash: version.structuredContent.manifest_hash,
    tool_manifest_sha256: version.structuredContent.tool_manifest_sha256,
    connector_metadata_sha256: version.structuredContent.connector_metadata_sha256,
    last_updated_at: "2000-01-02T12:34:56.000Z",
    last_updated_human: "Sunday, January 2, 2000 at 12:34:56 PM UTC",
    last_updated_unix: 946816496,
    last_updated_source: "release_metadata",
    read_only: true,
    tool_count: 3,
    framework: {
      name: "@canvas-lms-mcp/mcp-core",
      version: "0.2.0",
      contract_version: 2,
    },
  });
  assert.match(version.structuredContent.manifest_hash, /^[a-f0-9]{64}$/);
  assert.match(version.structuredContent.tool_manifest_sha256, /^[a-f0-9]{64}$/);
  assert.match(version.structuredContent.connector_metadata_sha256, /^[a-f0-9]{64}$/);

  const capabilities = await client.callTool({ name: "get_capabilities", arguments: {} });
  assert.equal(capabilities.structuredContent.tools.length, 3);
  assert.equal(capabilities.structuredContent.connector.description, "A contract-test connector for validating discovery behavior.");
  assert.equal(capabilities.structuredContent.connector.last_updated_unix, 946816496);
  assert.equal(capabilities.structuredContent.tools.find((tool) => tool.name === "echo").input_schema.properties.value.description, "Value for value used by echo.");
  assert.deepEqual(
    Object.fromEntries(Object.entries(capabilities.structuredContent.tools.find((tool) => tool.name === "echo"))
      .filter(([key]) => !["annotations", "input_schema", "output_schema"].includes(key))),
    {
      name: "echo",
      description: "Echo a value for contract testing.",
      read_only: true,
      destructive: false,
      open_world: false,
      idempotent: true,
      category: "general",
      requires_confirmation: false,
      external_mutation: false,
      side_effects: null,
    },
  );

  const echo = await client.callTool({ name: "echo", arguments: { value: "ok" } });
  assert.deepEqual(echo.structuredContent, { ok: true, value: "ok" });

  await client.close();
  await server.close();
});

test("default output validation accepts arbitrary structured object results", async () => {
  const server = createBaseMcpServer({ id: "generic-output-test", version: "1.0.0" });
  registerMcpTool(
    server,
    "generic",
    {
      description: "Return an arbitrary structured object.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => mcpResult({ ok: true, nested: { value: 42 }, items: ["a", "b"] }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "generic-output-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({ name: "generic", arguments: {} });
  assert.deepEqual(result.structuredContent, {
    ok: true,
    nested: { value: 42 },
    items: ["a", "b"],
  });

  await client.close();
  await server.close();
});

test("legacy registration overloads preserve annotations and request context", async () => {
  const server = createBaseMcpServer({ id: "parser-test", version: "1.0.0" });
  const annotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  };
  let observed;
  registerMcpTool(
    server,
    "legacy_handler_then_annotations",
    "Legacy registration form.",
    {},
    async (_args, extra) => {
      observed = extra;
      return mcpResult({ ok: true });
    },
    annotations,
  );
  registerMcpTool(
    server,
    "legacy_annotations_then_handler",
    "Older legacy registration form.",
    {},
    annotations,
    async () => mcpResult({ ok: true }),
  );

  const controller = new AbortController();
  const definition = getMcpToolDefinitions(server).find(
    (tool) => tool.name === "legacy_handler_then_annotations",
  );
  await runMcpRequestContext({ requestId: "request-123", signal: controller.signal }, () =>
    definition.handler({}, {}),
  );
  assert.equal(observed.requestId, "request-123");
  assert.equal(observed.signal, controller.signal);
  assert.deepEqual(
    getMcpToolCatalog(server).find((tool) => tool.name === "legacy_handler_then_annotations"),
    {
      name: "legacy_handler_then_annotations",
      description: "Legacy registration form.",
      read_only: false,
      destructive: true,
      open_world: true,
      idempotent: false,
      category: "general",
      requires_confirmation: true,
      external_mutation: true,
      side_effects: "May modify connector or upstream state; inspect the operation-specific tool description.",
    },
  );
  assert.throws(
    () => registerMcpTool(server, "missing-annotations", {}, async () => mcpResult({ ok: true })),
    /explicit annotations/,
  );
  assert.throws(
    () => registerMcpTool(
      server,
      "legacy_handler_then_annotations",
      { annotations },
      async () => mcpResult({ ok: true }),
    ),
    /already registered/,
  );
  await server.close();
});
