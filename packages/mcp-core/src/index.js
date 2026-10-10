import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const MCP_CORE_VERSION = "0.2.0";
export const MCP_CONTRACT_VERSION = 2;

const serverStates = new WeakMap();
const requestContexts = new AsyncLocalStorage();
// The MCP SDK's Zod compatibility layer normalizes output schemas as object
// schemas. A top-level z.record() is valid Zod, but is treated as a non-object
// schema by that normalizer and fails at call time. Keep arbitrary structured
// output while presenting the SDK with an object-shaped schema. The common
// fields make the fallback contract useful even when a domain service returns
// an upstream-specific object.
function genericOutputSchema(toolName) {
  return z
    .object({
      ok: z.boolean().optional().describe("Whether the operation completed successfully."),
      message: z.string().optional().describe("Human-readable result or status message, when provided."),
      data: z.unknown().optional().describe("Service-specific result data when the result is not represented by named fields."),
      error: z.unknown().optional().describe("Service-specific error details when the upstream reports an error."),
    })
    .passthrough()
    .describe(`Structured result returned by ${toolName}; additional fields are service-specific.`);
}

const versionOutputSchema = z.object({
  ok: z.literal(true),
  schema_version: z.literal(MCP_CONTRACT_VERSION),
  service: z.string(),
  version: z.string(),
  build_id: z.string().nullable(),
  commit: z.string().nullable(),
  built_at: z.string().nullable(),
  manifest_hash: z.string(),
  tool_manifest_sha256: z.string(),
  connector_metadata_sha256: z.string(),
  last_updated_at: z.string().nullable(),
  last_updated_human: z.string(),
  last_updated_unix: z.number().int().nullable(),
  last_updated_source: z.enum(["release_metadata", "runtime_metadata", "build_metadata", "unavailable"]),
  read_only: z.boolean(),
  tool_count: z.number().int().nonnegative(),
  framework: z.object({
    name: z.string(),
    version: z.string(),
    contract_version: z.number().int().positive(),
  }),
});

const capabilitiesOutputSchema = z.object({
  ok: z.literal(true),
  schema_version: z.literal(MCP_CONTRACT_VERSION),
  service: z.string(),
  version: z.string(),
  tool_count: z.number().int().nonnegative(),
  manifest_hash: z.string(),
  tool_manifest_sha256: z.string(),
  connector_metadata_sha256: z.string(),
  framework: z.object({
    name: z.string(),
    version: z.string(),
    contract_version: z.number().int().positive(),
  }),
  connector: z.object({
    description: z.string(),
    instructions: z.string(),
    use_when: z.array(z.string()),
    not_for: z.array(z.string()),
    authoritative_for: z.array(z.string()),
    related_services: z.array(z.string()),
    routing_notes: z.array(z.string()),
    read_only: z.boolean(),
    last_updated_at: z.string().nullable(),
    last_updated_human: z.string(),
    last_updated_unix: z.number().int().nullable(),
    last_updated_source: z.enum(["release_metadata", "runtime_metadata", "build_metadata", "unavailable"]),
  }),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      read_only: z.boolean(),
      destructive: z.boolean(),
      open_world: z.boolean(),
      idempotent: z.boolean(),
      category: z.string(),
      requires_confirmation: z.boolean(),
      external_mutation: z.boolean(),
      side_effects: z.string().nullable(),
      annotations: z.record(z.string(), z.unknown()),
      input_schema: z.unknown(),
      output_schema: z.unknown(),
    }),
  ),
});

const frameworkMetadata = {
  name: "@canvas-lms-mcp/mcp-core",
  version: MCP_CORE_VERSION,
  contract_version: MCP_CONTRACT_VERSION,
};

const UPDATE_SOURCES = ["release_metadata", "runtime_metadata", "build_metadata", "unavailable"];
const FRESHNESS_SOURCES = ["live", "cache", "derived", "unknown"];
const FRESHNESS_STATES = ["fresh", "stale", "unknown"];

function runtimeEnv() {
  return typeof process !== "undefined" && process.env ? process.env : undefined;
}

function nonEmpty(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${field} must be a non-empty string.`);
  return normalized;
}

function stringList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array of strings.`);
  return value.map((entry, index) => nonEmpty(entry, `${field}[${index}]`));
}

function optionalStringList(value, field) {
  return stringList(value, field);
}

function isZodSchema(value) {
  return Boolean(value && typeof value === "object" && (value._zod || value._def));
}

function rawObjectShape(value) {
  if (!value || typeof value !== "object" || isZodSchema(value)) return undefined;
  const values = Object.values(value);
  if (values.every(isZodSchema)) return value;
  return undefined;
}

function objectShapeFromSchema(value) {
  if (!isZodSchema(value)) return rawObjectShape(value);
  if (value._zod?.def?.type === "object") {
    const shape = value._zod.def.shape;
    return typeof shape === "function" ? shape() : shape;
  }
  if (value._def?.typeName === "ZodObject" || value._def?.shape) {
    const shape = value._def.shape;
    return typeof shape === "function" ? shape() : shape;
  }
  return undefined;
}

const commonFieldDescriptions = {
  account: "Optional account/profile identifier; omit it to use the connector default.",
  api: "Exact API or service name accepted by the connector.",
  version: "API version; use the connector's discovery tool when the version is unknown.",
  method: "Exact method or operation name returned by the connector's discovery tool.",
  path: "Service-relative path or workspace path, as described by the tool.",
  query: "Query/filter parameters for the requested service operation.",
  body: "Structured request body accepted by the requested service operation.",
  id: "Identifier of the target resource.",
  name: "Human-readable name for the target resource.",
  title: "Human-readable title for the target resource.",
  limit: "Maximum number of results to return; the tool may apply a lower safety cap.",
  page: "One-based page number when the upstream supports numbered pagination.",
  cursor: "Opaque continuation cursor returned by a previous call.",
  pageToken: "Opaque continuation token returned by a previous page of results.",
  page_token: "Opaque continuation token returned by a previous page of results.",
  confirm: "Explicit confirmation value required by the tool description before a state-changing operation.",
  command: "Command or operation to execute; review it against the tool's stated execution boundary.",
  script: "Non-interactive script to execute within the tool's stated execution boundary.",
  cwd: "Working directory for the operation, relative to the tool's documented workspace unless stated otherwise.",
  timeout_seconds: "Maximum execution time in seconds, subject to the connector's hard limit.",
  items: "Collection of resources returned by the operation.",
  methods: "Collection of callable methods or method descriptions.",
  tools: "Collection of tool descriptors or tool results.",
  pages: "Collection of pages or page results.",
  entries: "Collection of resource or diagnostic entries.",
  files: "Collection of file descriptors or file results.",
  artifacts: "Collection of published artifact descriptors.",
  count: "Number of returned or available items.",
  total_entries: "Total number of matching entries before this page was limited.",
  status: "Operation or upstream status value.",
  content: "Returned text or structured content.",
  text: "Returned human-readable text.",
  url: "URL returned by the upstream or artifact service.",
  timestamp: "Upstream or operation timestamp.",
  updated: "Last-update timestamp for the resource.",
  warnings: "Non-fatal warnings associated with the result.",
};

function humanizeFieldName(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function fieldDescription(name, toolName) {
  return commonFieldDescriptions[name]
    ?? `Value for ${humanizeFieldName(name)} used by ${toolName}.`;
}

function inferredCategory(toolName) {
  if (["get_version", "get_capabilities"].includes(toolName) || /(?:list_tools|connector_info|help)$/i.test(toolName)) return "discovery";
  if (/status|diagnostic|health|token_info|whoami|who_am_i/i.test(toolName)) return "diagnostics";
  if (/canvas_request|google_api_call|google_api_paginate/i.test(toolName)) return "api";
  if (/assignment|grade|gpa/i.test(toolName)) return "coursework";
  if (/course|module|announcement|discussion|page|todo|timetable|event/i.test(toolName)) return "course-content";
  if (/file|folder|document|spreadsheet|presentation|slide|drive|artifact/i.test(toolName)) return "files";
  if (/task/i.test(toolName)) return "tasks";
  if (/calendar/i.test(toolName)) return "calendar";
  if (/mail|message|attachment|channel|discord|gmail|chat/i.test(toolName)) return "messages";
  if (/contact|person|directory/i.test(toolName)) return "contacts";
  if (/wiki|wikitext|recent_changes|diff/i.test(toolName)) return "wiki";
  if (/alexa|device|routine|smart_home/i.test(toolName)) return "devices";
  if (/bash|python|workspace|cache|publish|clean|delete_path/i.test(toolName)) return "execution";
  return "general";
}

function timestampFrom(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function lastUpdatedInfo(metadata) {
  const env = runtimeEnv();
  const candidates = [
    [metadata?.lastUpdatedAt, "release_metadata"],
    [env?.MCP_LAST_UPDATED_AT, "runtime_metadata"],
    [metadata?.builtAt, "build_metadata"],
    [env?.MCP_BUILT_AT, "build_metadata"],
  ];
  for (const [value, source] of candidates) {
    const date = timestampFrom(value);
    if (!date) continue;
    return {
      lastUpdatedAt: date.toISOString(),
      lastUpdatedHuman: new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: "UTC",
      }).format(date),
      lastUpdatedUnix: Math.floor(date.getTime() / 1000),
      lastUpdatedSource: source,
    };
  }
  return {
    lastUpdatedAt: null,
    lastUpdatedHuman: "Unknown — no valid release or build timestamp was supplied.",
    lastUpdatedUnix: null,
    lastUpdatedSource: "unavailable",
  };
}

function enrichInputSchema(inputSchema, toolName) {
  const shape = objectShapeFromSchema(inputSchema);
  if (!shape) return inputSchema;
  const enriched = Object.fromEntries(Object.entries(shape).map(([name, schema]) => {
    if (!schema || typeof schema.describe !== "function" || schema.description) return [name, schema];
    return [name, schema.describe(fieldDescription(name, toolName))];
  }));
  if (!isZodSchema(inputSchema)) return enriched;
  if (typeof inputSchema.extend === "function") return inputSchema.extend(enriched);
  return inputSchema;
}

function jsonSchemaFor(schema, io) {
  const objectSchema = schema && !isZodSchema(schema) && objectShapeFromSchema(schema)
    ? z.object(schema)
    : schema;
  try {
    return z.toJSONSchema(objectSchema ?? z.object({}), { io });
  } catch (error) {
    return {
      type: "object",
      additionalProperties: true,
      description: `Schema conversion failed; inspect tools/list for the live schema (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}

function stateFor(server) {
  let state = serverStates.get(server);
  if (!state) {
    state = { metadata: undefined, tools: new Map() };
    serverStates.set(server, state);
  }
  return state;
}

function publicMetadata(metadata) {
  const env = runtimeEnv();
  const id = nonEmpty(metadata.id, "MCP id");
  const description = nonEmpty(metadata.description ?? `MCP service ${id}.`, "MCP description");
  const useWhen = stringList(metadata.useWhen, "MCP useWhen");
  const notFor = stringList(metadata.notFor, "MCP notFor");
  const authoritativeFor = optionalStringList(metadata.authoritativeFor, "MCP authoritativeFor");
  const relatedServices = stringList(metadata.relatedServices, "MCP relatedServices");
  const routingNotes = stringList(metadata.routingNotes, "MCP routingNotes");
  const generatedInstructions = [
    description,
    useWhen.length ? `Use this connector when: ${useWhen.join("; ")}` : "",
    notFor.length ? `Do not use it for: ${notFor.join("; ")}` : "",
    authoritativeFor.length ? `Authoritative for: ${authoritativeFor.join("; ")}` : "",
    relatedServices.length ? `Related connectors: ${relatedServices.join(", ")}.` : "",
    routingNotes.length ? `Routing notes: ${routingNotes.join("; ")}` : "",
    "Use tools/list or get_capabilities for the complete per-tool input/output contract before calling an unfamiliar tool.",
  ].filter(Boolean).join(" ");
  const updated = lastUpdatedInfo(metadata);
  return {
    id,
    version: nonEmpty(metadata.version, "MCP version"),
    buildId: metadata.buildId ?? env?.MCP_BUILD_ID ?? null,
    commit: (() => {
      const commit = metadata.commit ?? env?.MCP_COMMIT ?? null;
      return commit && commit !== "unknown" ? commit : null;
    })(),
    builtAt: metadata.builtAt ?? env?.MCP_BUILT_AT ?? null,
    readOnly: Boolean(metadata.readOnly),
    description,
    useWhen,
    notFor,
    authoritativeFor,
    relatedServices,
    routingNotes,
    instructions: nonEmpty(metadata.instructions ?? generatedInstructions, "MCP instructions"),
    ...updated,
  };
}

function stableValue(value, seen = new WeakSet()) {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const normalized = Array.isArray(value)
    ? value.map((entry) => stableValue(entry, seen))
    : Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key], seen)]),
    );
  seen.delete(value);
  return normalized;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function connectorMetadataFor(metadata) {
  return {
    id: metadata.id,
    version: metadata.version,
    build_id: metadata.buildId,
    commit: metadata.commit,
    built_at: metadata.builtAt,
    last_updated_at: metadata.lastUpdatedAt,
    last_updated_source: metadata.lastUpdatedSource,
    read_only: metadata.readOnly,
    description: metadata.description,
    instructions: metadata.instructions,
    use_when: metadata.useWhen,
    not_for: metadata.notFor,
    authoritative_for: metadata.authoritativeFor,
    related_services: metadata.relatedServices,
    routing_notes: metadata.routingNotes,
  };
}

function normalizedConfig(config, toolName) {
  const input = config && typeof config === "object" ? config : {};
  if (!input.annotations || typeof input.annotations !== "object") {
    throw new TypeError("Every MCP tool must declare explicit annotations.");
  }
  for (const field of ["readOnlyHint", "destructiveHint", "openWorldHint"]) {
    if (typeof input.annotations[field] !== "boolean") {
      throw new TypeError(`MCP tool annotation ${field} must be a boolean.`);
    }
  }
  const annotations = {
    ...input.annotations,
    idempotentHint: Boolean(input.annotations.idempotentHint),
  };
  const { category, requiresConfirmation, sideEffects, externalMutation, ...sdkConfig } = input;
  const normalizedExternalMutation = Boolean(externalMutation ?? !annotations.readOnlyHint);
  return {
    sdk: {
      ...sdkConfig,
      inputSchema: enrichInputSchema(input.inputSchema, toolName),
      annotations,
      outputSchema: enrichInputSchema(input.outputSchema ?? genericOutputSchema(toolName), toolName),
    },
    catalog: {
      category: nonEmpty(category ?? inferredCategory(toolName), "MCP tool category"),
      // Destructive tools require an explicit user confirmation by default.
      // A service can still opt out deliberately for a narrowly controlled
      // operation by setting requiresConfirmation: false.
      requiresConfirmation: Boolean(requiresConfirmation ?? annotations.destructiveHint),
      externalMutation: normalizedExternalMutation,
      sideEffects: sideEffects === undefined
        ? normalizedExternalMutation
          ? "May modify connector or upstream state; inspect the operation-specific tool description."
          : null
        : nonEmpty(sideEffects, "MCP tool sideEffects"),
    },
  };
}

function descriptorFrom(name, config, catalog) {
  const annotations = config.annotations;
  return {
    name,
    description: String(config.description ?? config.title ?? name),
    read_only: Boolean(annotations.readOnlyHint),
    destructive: Boolean(annotations.destructiveHint),
    open_world: Boolean(annotations.openWorldHint),
    idempotent: Boolean(annotations.idempotentHint),
    category: catalog.category,
    requires_confirmation: catalog.requiresConfirmation,
    external_mutation: catalog.externalMutation,
    side_effects: catalog.sideEffects,
  };
}

function toolContractsFor(server) {
  return [...(serverStates.get(server)?.tools.values() ?? [])].map((entry) => ({
    ...entry.descriptor,
    annotations: entry.registered.annotations ?? {},
    input_schema: jsonSchemaFor(entry.registered.inputSchema, "input"),
    output_schema: jsonSchemaFor(entry.registered.outputSchema, "output"),
  }));
}

function manifestFingerprintsFor(server) {
  const state = serverStates.get(server);
  const connectorMetadataSha256 = sha256(connectorMetadataFor(state?.metadata ?? {}));
  const toolManifest = toolContractsFor(server)
    .sort((left, right) => left.name.localeCompare(right.name));
  const toolManifestSha256 = sha256(toolManifest);
  const manifestHash = sha256({
    contract_version: MCP_CONTRACT_VERSION,
    connector_metadata_sha256: connectorMetadataSha256,
    tool_manifest_sha256: toolManifestSha256,
  });
  return {
    manifest_hash: manifestHash,
    tool_manifest_sha256: toolManifestSha256,
    connector_metadata_sha256: connectorMetadataSha256,
  };
}

function parseRegistrationArgs(args) {
  if (typeof args[0] === "string") {
    const [description, inputSchema, annotationsOrHandler, maybeHandler, category, requiresConfirmation] = args;
    if (typeof annotationsOrHandler === "function") {
      return {
        config: { description, inputSchema, annotations: maybeHandler, category, requiresConfirmation },
        handler: annotationsOrHandler,
      };
    }
    return {
      config: { description, inputSchema, annotations: annotationsOrHandler, category, requiresConfirmation },
      handler: maybeHandler,
    };
  }
  return { config: args[0] ?? {}, handler: args[1] };
}

/**
 * Construct the common part of every MCP server. Domain tools should be
 * registered through registerMcpTool so the standard capability catalog stays
 * accurate without reaching into SDK private fields.
 */
export function createBaseMcpServer(metadata) {
  const normalizedMetadata = publicMetadata(metadata);
  const server = new McpServer(
    { name: normalizedMetadata.id, version: normalizedMetadata.version },
    normalizedMetadata.instructions ? { instructions: normalizedMetadata.instructions } : undefined,
  );
  const state = { metadata: normalizedMetadata, tools: new Map() };
  serverStates.set(server, state);

  registerMcpTool(
    server,
    "get_version",
    {
      description: "Return this MCP service identity, release/build metadata, and last-updated time as UTC ISO-8601, UTC prose, and Unix seconds. Read-only.",
      inputSchema: {},
      outputSchema: versionOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      mcpResult({
        ok: true,
        schema_version: MCP_CONTRACT_VERSION,
        service: normalizedMetadata.id,
        version: normalizedMetadata.version,
        build_id: normalizedMetadata.buildId,
        commit: normalizedMetadata.commit,
        built_at: normalizedMetadata.builtAt,
        ...manifestFingerprintsFor(server),
        last_updated_at: normalizedMetadata.lastUpdatedAt,
        last_updated_human: normalizedMetadata.lastUpdatedHuman,
        last_updated_unix: normalizedMetadata.lastUpdatedUnix,
        last_updated_source: normalizedMetadata.lastUpdatedSource,
        read_only: normalizedMetadata.readOnly,
        tool_count: state.tools.size,
        framework: frameworkMetadata,
      }),
  );

  registerMcpTool(
    server,
    "get_capabilities",
    {
      description: "Return the complete categorized capability catalog for this MCP, including connector last-updated metadata. Read-only.",
      inputSchema: {},
      outputSchema: capabilitiesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      mcpResult({
        ok: true,
        schema_version: MCP_CONTRACT_VERSION,
        service: normalizedMetadata.id,
        version: normalizedMetadata.version,
        tool_count: state.tools.size,
        ...manifestFingerprintsFor(server),
        framework: frameworkMetadata,
        connector: {
          description: normalizedMetadata.description,
          instructions: normalizedMetadata.instructions,
          use_when: normalizedMetadata.useWhen,
          not_for: normalizedMetadata.notFor,
          authoritative_for: normalizedMetadata.authoritativeFor,
          related_services: normalizedMetadata.relatedServices,
          routing_notes: normalizedMetadata.routingNotes,
          read_only: normalizedMetadata.readOnly,
          last_updated_at: normalizedMetadata.lastUpdatedAt,
          last_updated_human: normalizedMetadata.lastUpdatedHuman,
          last_updated_unix: normalizedMetadata.lastUpdatedUnix,
          last_updated_source: normalizedMetadata.lastUpdatedSource,
        },
        tools: toolContractsFor(server),
      }),
  );

  return server;
}

/**
 * Register a tool through the current MCP SDK API and apply safe defaults.
 * Supports both the modern config form and the old description/schema form so
 * migrations can be mechanical without reintroducing the deprecated SDK API.
 */
export function registerMcpTool(server, name, ...args) {
  const normalizedName = nonEmpty(name, "MCP tool name");
  const registration = parseRegistrationArgs(args);
  if (typeof registration.handler !== "function") {
    throw new TypeError(`A handler is required for MCP tool ${normalizedName}.`);
  }
  const state = stateFor(server);
  if (state.tools.has(normalizedName)) {
    throw new Error(`MCP tool ${normalizedName} is already registered.`);
  }
  const config = normalizedConfig(registration.config, normalizedName);
  const handler = async (input, extra) => {
    const context = requestContexts.getStore();
    try {
      if (!context) return await registration.handler(input, extra);
      return await registration.handler(input, {
        ...(extra ?? {}),
        requestId: context.requestId,
        signal: extra?.signal ?? context.signal,
      });
    } catch (error) {
      return mcpErrorResult(error, { requestId: context?.requestId });
    }
  };
  const registered = server.registerTool(normalizedName, config.sdk, handler);
  state.tools.set(normalizedName, {
    descriptor: descriptorFrom(normalizedName, config.sdk, config.catalog),
    registered,
  });
  return registered;
}

export function runMcpRequestContext(context, work) {
  return requestContexts.run(context, work);
}

export function getMcpRequestContext() {
  return requestContexts.getStore();
}

export function setMcpToolOutputSchemas(server, schemas) {
  const state = serverStates.get(server);
  if (!state) throw new Error("MCP server was not created by createBaseMcpServer.");
  for (const [name, schema] of Object.entries(schemas)) {
    const entry = state.tools.get(name);
    if (!entry) throw new Error(`Missing registered MCP tool for output schema: ${name}`);
    const enriched = enrichInputSchema(schema, name);
    // The SDK update API accepts only a raw shape and reconstructs it as a
    // strict object, which would discard a domain schema's passthrough policy
    // and make the published JSON Schema narrower than the live validator.
    // Update once for the SDK's list-changed notification, then retain the
    // original object schema on the public RegisteredTool handle.
    entry.registered.update({ outputSchema: outputSchemaShape(enriched) });
    entry.registered.outputSchema = enriched;
  }
}

function outputSchemaShape(schema) {
  if (schema && typeof schema === "object" && "shape" in schema) {
    const shape = schema.shape;
    if (typeof shape === "function") return shape();
    if (shape && typeof shape === "object") return shape;
  }
  return schema;
}

export function getMcpToolCatalog(server) {
  return [...(serverStates.get(server)?.tools.values() ?? [])].map((entry) => entry.descriptor);
}

/**
 * Return normalized release/build update information for custom status or
 * connector-info tools. `last_updated_human` is UTC and
 * `last_updated_unix` is Unix seconds. The source is explicit when no valid
 * timestamp was supplied rather than silently using process start time.
 */
export function getMcpLastUpdated(metadata) {
  const updated = lastUpdatedInfo(metadata ?? {});
  return {
    last_updated_at: updated.lastUpdatedAt,
    last_updated_human: updated.lastUpdatedHuman,
    last_updated_unix: updated.lastUpdatedUnix,
    last_updated_source: updated.lastUpdatedSource,
  };
}

/**
 * Normalize read freshness so callers can distinguish a live read, a cached
 * snapshot, a derived value, and an unknown source without parsing prose.
 */
export function mcpFreshness({
  source = "unknown",
  fetchedAt = null,
  maxAgeMs = undefined,
  now = Date.now(),
} = {}) {
  const normalizedSource = FRESHNESS_SOURCES.includes(source) ? source : "unknown";
  const readDate = timestampFrom(now) ?? new Date();
  const fetchedDate = timestampFrom(fetchedAt);
  const ageMs = fetchedDate
    ? Math.max(0, readDate.getTime() - fetchedDate.getTime())
    : null;
  const threshold = Number.isFinite(maxAgeMs)
    ? Math.max(0, Number(maxAgeMs))
    : normalizedSource === "live"
      ? 120_000
      : undefined;
  const freshness = ageMs === null || threshold === undefined
    ? "unknown"
    : ageMs <= threshold
      ? "fresh"
      : "stale";
  return {
    source: normalizedSource,
    fetched_at: fetchedDate?.toISOString() ?? null,
    read_at: readDate.toISOString(),
    age_seconds: ageMs === null ? null : Math.floor(ageMs / 1_000),
    freshness,
  };
}

/**
 * Normalize continuation information. Provider-specific page tokens remain
 * inside the connector response, while agents get one predictable envelope.
 */
export function mcpPagination({
  hasMore = false,
  nextCursor = null,
  totalCount = null,
  truncated = false,
} = {}) {
  return {
    has_more: Boolean(hasMore),
    next_cursor: nextCursor === undefined || nextCursor === null ? null : String(nextCursor),
    total_count: Number.isInteger(totalCount) && totalCount >= 0 ? totalCount : null,
    truncated: Boolean(truncated),
  };
}

/**
 * Compose the common read envelope used by connectors that expose freshness
 * and pagination alongside provider-specific data.
 */
export function mcpReadMetadata(options = {}) {
  return {
    ...mcpFreshness(options),
    pagination: mcpPagination(options),
  };
}

/**
 * Return the complete public contract for every registered tool. Unlike the
 * compact catalog, this includes the JSON Schema that an agent needs to
 * construct calls and interpret structured results.
 */
export function getMcpToolContracts(server) {
  return toolContractsFor(server);
}

/**
 * Return stable hashes for the advertised connector metadata and complete
 * tool manifest. These are calculated from the public contract so a client or
 * audit can detect stale discovery without inspecting implementation files.
 */
export function getMcpManifestFingerprints(server) {
  return manifestFingerprintsFor(server);
}

/**
 * Return the public SDK registration handles tracked by the shared core.
 * This is primarily useful for contract tests and diagnostics; application
 * discovery should use getMcpToolCatalog or the get_capabilities tool.
 */
export function getMcpToolDefinitions(server) {
  return [...(serverStates.get(server)?.tools.values() ?? [])].map(({ descriptor, registered }) => ({
    ...descriptor,
    inputSchema: registered.inputSchema,
    outputSchema: registered.outputSchema,
    annotations: registered.annotations,
    handler: registered.handler,
  }));
}

export function toStructuredContent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") return { ok: true, message: value };
  return { ok: true, data: value === undefined ? null : value };
}

export function mcpResult(value) {
  const structured = toStructuredContent(value);
  if (structured.ok === false && Object.hasOwn(structured, "error")) {
    const reported = structured.error;
    const reportedRecord = reported && typeof reported === "object" && !Array.isArray(reported)
      ? reported
      : {};
    const message = typeof reported === "string"
      ? reported
      : typeof reportedRecord.message === "string"
        ? reportedRecord.message
        : "The connector reported an error.";
    const details = { ...structured };
    delete details.ok;
    delete details.error;
    return mcpErrorResult(new Error(message), {
      code: typeof reportedRecord.code === "string" ? reportedRecord.code : undefined,
      retryable: typeof reportedRecord.retryable === "boolean" ? reportedRecord.retryable : undefined,
      userActionRequired: typeof reportedRecord.user_action_required === "boolean"
        ? reportedRecord.user_action_required
        : undefined,
      providerStatus: Number.isInteger(reportedRecord.provider_status) ? reportedRecord.provider_status : undefined,
      retryAfterSeconds: Number.isFinite(reportedRecord.retry_after_seconds)
        ? Number(reportedRecord.retry_after_seconds)
        : undefined,
      details: Object.keys(details).length > 0 ? details : undefined,
    });
  }
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
  return {
    structuredContent: structured,
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

export function mcpErrorResult(error, options = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const status = options.providerStatus
    ?? error?.status
    ?? error?.statusCode
    ?? error?.response?.status
    ?? null;
  const normalizedStatus = Number.isInteger(status) ? status : null;
  const knownCodes = new Set([
    "AUTH_REQUIRED",
    "AUTH_EXPIRED",
    "PERMISSION_DENIED",
    "NOT_FOUND",
    "AMBIGUOUS_TARGET",
    "INVALID_ARGUMENT",
    "RATE_LIMITED",
    "PROVIDER_UNAVAILABLE",
    "STALE_CACHE",
    "READ_ONLY",
    "WRITE_NOT_ALLOWLISTED",
    "CONCURRENT_MODIFICATION",
    "UNSUPPORTED_OPERATION",
    "RESULT_TOO_LARGE",
    "INTERNAL_ERROR",
    "CONNECTOR_ERROR",
    "PATH_NOT_ALLOWED",
    "UPSTREAM_REDIRECT_REJECTED",
    "UI_ELEMENT_NOT_FOUND",
    "UPSTREAM_TIMEOUT",
  ]);
  const errorCode = typeof error?.contractCode === "string" && knownCodes.has(error.contractCode)
    ? error.contractCode
    : options.code
      ?? (normalizedStatus === 401 ? "AUTH_REQUIRED"
        : normalizedStatus === 403 ? "PERMISSION_DENIED"
          : normalizedStatus === 404 ? "NOT_FOUND"
            : normalizedStatus === 409 ? "CONCURRENT_MODIFICATION"
              : normalizedStatus === 413 ? "RESULT_TOO_LARGE"
                : normalizedStatus === 429 ? "RATE_LIMITED"
                  : normalizedStatus !== null && normalizedStatus >= 500 ? "PROVIDER_UNAVAILABLE"
                    : "CONNECTOR_ERROR");
  const retryable = options.retryable
    ?? ["RATE_LIMITED", "PROVIDER_UNAVAILABLE", "UPSTREAM_TIMEOUT"].includes(errorCode);
  const userActionRequired = options.userActionRequired
    ?? [
      "AUTH_REQUIRED",
      "AUTH_EXPIRED",
      "PERMISSION_DENIED",
      "AMBIGUOUS_TARGET",
      "INVALID_ARGUMENT",
      "READ_ONLY",
      "WRITE_NOT_ALLOWLISTED",
      "PATH_NOT_ALLOWED",
    ].includes(errorCode);
  const requestId = options.requestId ?? getMcpRequestContext()?.requestId ?? null;
  const retryAfterSeconds = options.retryAfterSeconds
    ?? error?.retryAfterSeconds
    ?? error?.retry_after_seconds
    ?? null;
  const value = {
    ok: false,
    schema_version: MCP_CONTRACT_VERSION,
    error: {
      code: errorCode,
      message: message.slice(0, options.maxMessageLength ?? 1_000),
      retryable: Boolean(retryable),
      user_action_required: Boolean(userActionRequired),
      provider_status: normalizedStatus,
      retry_after_seconds: Number.isFinite(retryAfterSeconds) ? Number(retryAfterSeconds) : null,
      request_id: requestId,
      ...(options.details === undefined ? {} : { details: options.details }),
    },
  };
  return {
    isError: true,
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

export async function safeMcpCall(work, options = {}) {
  try {
    return mcpResult(await work());
  } catch (error) {
    return mcpErrorResult(error, options);
  }
}

export function createMcpRelease({ id, version, ...rest }) {
  return Object.freeze({ id: nonEmpty(id, "MCP id"), version: nonEmpty(version, "MCP version"), ...rest });
}
