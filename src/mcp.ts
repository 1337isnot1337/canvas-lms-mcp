import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createBaseMcpServer, getMcpLastUpdated, getMcpManifestFingerprints, getMcpToolCatalog, mcpReadMetadata, registerMcpTool, setMcpToolOutputSchemas } from "@canvas-lms-mcp/mcp-core";
import { z } from "zod";
import type { RuntimeConfig } from "./config";
import {
  canvasHeaderProbe,
  canvasRequest,
  sanitizedCanvasHeaders,
  type CanvasMethod,
  type CanvasProbeProfile,
  type QueryParams,
  type ResponseMode,
} from "./canvas/http";
import { canvasPaginate } from "./canvas/pagination";
import {
  getCanvasFileMetadata,
  getCanvasFileContent,
  getCanvasFileRaw,
  getCanvasFileText,
} from "./canvas/files";
import { CANVAS_TOOL_ALIASES, TOP_30_TOOLS, type Top30ToolDefinition } from "./canvas/top30";
import { arrayBufferToBase64 } from "./canvas/http";
import { jsonText } from "./util/json";
import { MCP_RELEASE } from "./release";

const methodSchema = z.enum(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const responseModeSchema = z.enum(["auto", "json", "text", "base64"]);
const probeProfileSchema = z.enum([
  "configured",
  "canvas_json",
  "browser_json",
  "browser_navigation",
  "browser_sec_fetch",
  "curl_json",
  "minimal",
  "no_user_agent",
  "no_accept",
]);
const queryValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
  z.null(),
]);
const CORE_TOOL_NAMES = [
  "get_canvas_mcp_status",
  "canvas_request",
  "canvas_paginate",
  "canvas_header_probe",
  "get_canvas_file_metadata",
  "get_canvas_file_text",
  "get_canvas_file_raw",
  "get_canvas_file_content",
  "resolve_course",
  "get_course_dashboard",
] as const;
const DIAGNOSTIC_SCHEMA_VERSION = "header-diagnostics-v2";

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const headersSchema = z.record(z.string(), z.string());
const readMetadataSchema = z.object({
  source: z.enum(["live", "cache", "derived", "unknown"]),
  fetched_at: z.string().nullable(),
  read_at: z.string(),
  age_seconds: z.number().int().nullable(),
  freshness: z.enum(["fresh", "stale", "unknown"]),
  pagination: z.object({
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
    total_count: z.number().int().nullable(),
    truncated: z.boolean(),
  }),
});
const canvasResponseOutputSchema = z.object({
  ok: z.boolean(),
  status: z.number().int(),
  statusText: z.string(),
  url: z.string(),
  contentType: z.string().nullable(),
  link: z.string().nullable(),
  data: jsonValueSchema,
  truncated: z.boolean().optional(),
  encoding: z.enum(["base64"]).optional(),
  source: z.enum(["live", "cache", "derived", "unknown"]).optional(),
  fetched_at: z.string().nullable().optional(),
  read_at: z.string().optional(),
  age_seconds: z.number().int().nullable().optional(),
  freshness: z.enum(["fresh", "stale", "unknown"]).optional(),
  pagination: z.object({
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
    total_count: z.number().int().nullable(),
    truncated: z.boolean(),
  }).optional(),
}).passthrough();
const canvasHeaderProbeOutputSchema = z.object({
  ok: z.boolean(),
  url: z.string(),
  results: z.array(
    z.object({
      profile: probeProfileSchema,
      include_authorization: z.boolean(),
      request_headers: headersSchema,
      response_headers: headersSchema,
      status: z.number().int(),
      statusText: z.string(),
      url: z.string(),
      contentType: z.string().nullable(),
      body_preview: z.string(),
      classification: z.string(),
    }),
  ),
  ...readMetadataSchema.shape,
});
const canvasFileMetadataOutputSchema = z
  .object({
    id: z.number().int(),
    display_name: z.string().optional(),
    filename: z.string().optional(),
    "content-type": z.string().optional(),
    url: z.string().optional(),
    size: z.number().int().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    locked: z.boolean().optional(),
    hidden: z.boolean().optional(),
    locked_for_user: z.boolean().optional(),
    hidden_for_user: z.boolean().optional(),
    lock_explanation: z.string().optional(),
    provider_url: z.string().nullable().optional(),
    read_metadata: readMetadataSchema.optional(),
  })
  .passthrough();
const canvasFileTextOutputSchema = z.object({
  ok: z.literal(true),
  file_id: z.number().int(),
  filename: z.string(),
  mime_type: z.string(),
  size: z.number().int().nullable(),
  text: z.string(),
  truncated: z.boolean(),
  provider_url: z.string().nullable(),
  read_metadata: readMetadataSchema,
});
const canvasFileRawOutputSchema = z.object({
  ok: z.literal(true),
  file_id: z.number().int(),
  filename: z.string(),
  mime_type: z.string(),
  size: z.number().int().nullable(),
  base64: z.string(),
  provider_url: z.string().nullable().optional(),
  read_metadata: readMetadataSchema,
});
const canvasFileContentOutputSchema = z.object({
  ok: z.literal(true),
  file_id: z.number().int(),
  filename: z.string(),
  mime_type: z.string(),
  size: z.number().int().nullable(),
  provider_url: z.string().nullable(),
  resource_uri: z.string(),
  read_metadata: readMetadataSchema,
});
const courseMatchSchema = z.object({
  course_id: z.number().int(),
  name: z.string().nullable(),
  course_code: z.string().nullable(),
  sis_course_id: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});
const canvasOutputSchemas = {
  get_canvas_mcp_status: z.object({
    ok: z.literal(true),
    mcp_schema_version: z.string(),
    last_updated_at: z.string().nullable(),
    last_updated_human: z.string(),
    last_updated_unix: z.number().int().nullable(),
  last_updated_source: z.enum(["release_metadata", "runtime_metadata", "build_metadata", "unavailable"]),
    service: z.literal("canvas-mcp"),
    version: z.string(),
    build_id: z.string().nullable(),
    commit: z.string().nullable(),
    built_at: z.string().nullable(),
    manifest_hash: z.string(),
    tool_manifest_sha256: z.string(),
    connector_metadata_sha256: z.string(),
    canvas_base_url: z.string(),
    canvas_request_headers: headersSchema,
    canvas_relay_configured: z.boolean(),
    canvas_transport: z.enum(["direct", "relay"]),
    read_only: z.boolean(),
    max_api_response_bytes: z.number().int(),
    max_file_bytes: z.number().int(),
    max_text_chars: z.number().int(),
    core_tools_registered: z.array(z.enum(CORE_TOOL_NAMES)),
    diagnostic_tools_registered: z.array(z.string()),
    course_tools_registered: z.array(z.string()),
    total_tools_registered: z.number().int(),
    tool_count: z.number().int(),
    permissions: z.object({
      read_only: z.boolean(),
      writes_enabled: z.boolean(),
      write_allowlist: z.array(z.string()),
      sensitive_operations_enabled: z.boolean(),
      provider_scopes: z.array(z.string()),
    }),
  }),
  canvas_request: canvasResponseOutputSchema,
  canvas_paginate: z.object({
    ok: z.boolean(),
    pages_fetched: z.number().int(),
    items: z.array(jsonValueSchema),
    pages: z.array(jsonValueSchema).optional(),
    source: z.enum(["live", "cache", "derived", "unknown"]),
    fetched_at: z.string().nullable(),
    read_at: z.string(),
    age_seconds: z.number().int().nullable(),
    freshness: z.enum(["fresh", "stale", "unknown"]),
    pagination: z.object({
      has_more: z.boolean(),
      next_cursor: z.string().nullable(),
      total_count: z.number().int().nullable(),
      truncated: z.boolean(),
    }),
    last_response: z.object({
      status: z.number().int(),
      statusText: z.string(),
      url: z.string(),
      link: z.string().nullable(),
    }),
  }).passthrough(),
  canvas_header_probe: canvasHeaderProbeOutputSchema,
  get_canvas_file_metadata: canvasFileMetadataOutputSchema,
  get_canvas_file_text: canvasFileTextOutputSchema,
  get_canvas_file_raw: canvasFileRawOutputSchema,
  get_canvas_file_content: canvasFileContentOutputSchema,
  resolve_course: z.object({
    ok: z.literal(true),
    query: z.string(),
    ambiguous: z.boolean(),
    matches: z.array(courseMatchSchema),
    read_metadata: readMetadataSchema,
  }).passthrough(),
  get_course_dashboard: z.object({
    ok: z.literal(true),
    course_id: z.number().int(),
    assignments: z.array(jsonValueSchema),
    missing_submissions: z.array(jsonValueSchema),
    announcements: z.array(jsonValueSchema),
    read_metadata: readMetadataSchema,
  }).passthrough(),
} satisfies Record<string, z.ZodType>;

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const requestAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export function createCanvasMcpServer(config: RuntimeConfig): McpServer {
  const server = createBaseMcpServer({
    ...MCP_RELEASE,
    readOnly: config.readOnly,
    description: "Canvas LMS connector for courses, assignments, due dates, missing submissions, announcements, modules, discussions, pages, course files, todos, and Canvas API reads.",
    useWhen: [
      "Canvas courses and course IDs",
      "assignments, due dates, missing submissions, assignment groups, and course todos",
      "announcements, modules, discussions, pages, course files, or upcoming Canvas events",
    ],
    notFor: [
      "records maintained outside the configured Canvas instance",
      "writing to Canvas; this connector is read-only",
    ],
    authoritativeFor: [
      "Canvas assignment instructions and Canvas-hosted due dates",
      "Canvas announcements, modules, pages, discussions, and course files",
      "Canvas missing-submission and Canvas todo state",
    ],
    relatedServices: [],
    routingNotes: [
      "Use resolve_course or list_courses first to resolve a human course name to a numeric Canvas course ID.",
    ],
  });

  registerMcpTool(server,
    "get_canvas_mcp_status",
    "Return non-secret Canvas MCP configuration, runtime status, and last-updated time in UTC prose and Unix seconds.",
    {},
    async () =>
      jsonText({
        ok: true,
        mcp_schema_version: DIAGNOSTIC_SCHEMA_VERSION,
        ...getMcpLastUpdated(MCP_RELEASE),
        service: MCP_RELEASE.id,
        version: MCP_RELEASE.version,
        build_id: MCP_RELEASE.buildId ?? null,
        commit: MCP_RELEASE.commit ?? null,
        built_at: MCP_RELEASE.builtAt ?? null,
        ...getMcpManifestFingerprints(server),
        canvas_base_url: config.canvasBaseUrl,
        canvas_request_headers: sanitizedCanvasHeaders(config),
        canvas_relay_configured: Boolean(config.canvasRelay),
        canvas_transport: config.canvasRelay ? "relay" : "direct",
        read_only: config.readOnly,
        max_api_response_bytes: config.maxApiResponseBytes,
        max_file_bytes: config.maxFileBytes,
        max_text_chars: config.maxTextChars,
        core_tools_registered: CORE_TOOL_NAMES,
        diagnostic_tools_registered: [
          "canvas_header_probe",
          "canvas_request path=/__diagnostics/header_probe",
        ],
        course_tools_registered: TOP_30_TOOLS.map((tool) => tool.name),
        total_tools_registered: getMcpToolCatalog(server).length,
        tool_count: getMcpToolCatalog(server).length,
        permissions: {
          read_only: config.readOnly,
          writes_enabled: !config.readOnly,
          write_allowlist: config.readOnly ? [] : ["canvas_request non-GET methods"],
          sensitive_operations_enabled: false,
          provider_scopes: ["Configured Canvas API token; this connector does not expose token scopes."],
        },
      }),
    readAnnotations,
  );

  registerMcpTool(server,
    "canvas_request",
    "Call any Canvas API endpoint under /api/v1. This is the complete API escape hatch. In READ_ONLY=true, non-read methods are blocked. Diagnostic path /__diagnostics/header_probe runs safe GET header probes.",
    {
      method: methodSchema.optional().default("GET"),
      path: z
        .string()
        .min(1)
        .describe("Canvas API-relative path or same-origin Canvas API URL, for example /courses or https://canvas.example.edu/api/v1/courses/123/assignments."),
      query: z.record(z.string(), queryValueSchema).optional(),
      body: z.unknown().optional().describe("JSON request body for POST, PUT, or PATCH requests."),
      response_mode: responseModeSchema.optional().default("auto"),
    },
    async ({ method, path, query, body, response_mode }) => {
      if (path === "/__diagnostics/header_probe" || path === "__diagnostics/header_probe") {
        return jsonText(
          await canvasHeaderProbe(
            config,
            diagnosticOptionsFromCanvasRequest(query as QueryParams | undefined, body),
          ),
        );
      }

      const requestOptions: {
        method: CanvasMethod;
        path: string;
        query?: QueryParams;
        body?: unknown;
        responseMode: ResponseMode;
      } = {
        method: method as CanvasMethod,
        path,
        responseMode: response_mode as ResponseMode,
      };

      if (query !== undefined) requestOptions.query = query as QueryParams;
      if (body !== undefined) requestOptions.body = body;

      return jsonText(await canvasRequest(config, requestOptions));
    },
    requestAnnotations,
  );

  registerMcpTool(server,
    "canvas_paginate",
    "Fetch a paginated Canvas list endpoint, following rel=next links. Defaults to per_page=100 and max_pages=10.",
    {
      path: z.string().min(1).describe("Canvas API-relative list path or same-origin Canvas API URL."),
      query: z.record(z.string(), queryValueSchema).optional(),
      per_page: z.number().int().min(1).max(100).optional(),
      max_pages: z.number().int().min(1).max(50).optional().default(10),
    },
    async ({ path, query, per_page, max_pages }) => {
      const paginateOptions: {
        path: string;
        query?: QueryParams;
        perPage?: number;
        maxPages: number;
      } = { path, maxPages: max_pages };

      if (query !== undefined) paginateOptions.query = query as QueryParams;
      if (per_page !== undefined) paginateOptions.perPage = per_page;

      return jsonText(await canvasPaginate(config, paginateOptions));
    },
    readAnnotations,
  );

  registerMcpTool(server,
    "canvas_header_probe",
    "Diagnostic only: issue safe GET probes to one Canvas API path using multiple request-header profiles, with and without Authorization, to identify Canvas proxy rejection behavior. Does not write to Canvas.",
    {
      path: z.string().min(1).optional().default("/courses").describe("Canvas API-relative path or same-origin Canvas API URL to probe."),
      query: z.record(z.string(), queryValueSchema).optional().default({ per_page: 1 }),
      profiles: z.array(probeProfileSchema).min(1).max(6).optional(),
      include_authorization: z.array(z.boolean()).min(1).max(2).optional(),
    },
    async ({ path, query, profiles, include_authorization }) => {
      const options: {
        path: string;
        query?: QueryParams;
        profiles?: CanvasProbeProfile[];
        includeAuthorization?: boolean[];
      } = { path };

      if (query !== undefined) options.query = query as QueryParams;
      if (profiles !== undefined) options.profiles = profiles as CanvasProbeProfile[];
      if (include_authorization !== undefined) {
        options.includeAuthorization = include_authorization;
      }

      return jsonText(await canvasHeaderProbe(config, options));
    },
    readAnnotations,
  );

  registerMcpTool(server,
    "get_canvas_file_metadata",
    "Get Canvas file metadata by file ID.",
    { file_id: z.union([z.string().min(1), z.number().int()]) },
    async ({ file_id }) => jsonText(await getCanvasFileMetadata(config, file_id)),
    readAnnotations,
  );

  registerMcpTool(server,
    "get_canvas_file_text",
    "Download a Canvas file by file ID and extract text. Supports DOCX, TXT, and HTML.",
    { file_id: z.union([z.string().min(1), z.number().int()]) },
    async ({ file_id }) => jsonText(await getCanvasFileText(config, file_id)),
    readAnnotations,
  );

  registerMcpTool(server,
    "get_canvas_file_raw",
    "Compatibility download for a Canvas file by file ID returning base64. Subject to MAX_FILE_BYTES; prefer get_canvas_file_content for a native MCP file/resource handle.",
    { file_id: z.union([z.string().min(1), z.number().int()]) },
    async ({ file_id }) => {
      const file = await getCanvasFileRaw(config, file_id);
      const metadata = await getCanvasFileMetadata(config, file_id);
      return jsonText({ ...file, provider_url: metadata.url ?? null });
    },
    readAnnotations,
  );

  registerMcpTool(server,
    "get_canvas_file_content",
    "Download a Canvas file by file ID and return a native MCP file resource instead of placing the full base64 payload in structured model context.",
    { file_id: z.union([z.string().min(1), z.number().int()]) },
    async ({ file_id }) => {
      const file = await getCanvasFileContent(config, file_id);
      const resourceUri = `canvas://files/${file.file_id}/${encodeURIComponent(file.filename)}`;
      return {
        structuredContent: {
          ok: true,
          file_id: file.file_id,
          filename: file.filename,
          mime_type: file.mime_type,
          size: file.size,
          provider_url: file.provider_url,
          resource_uri: resourceUri,
          read_metadata: file.read_metadata,
        },
        content: [{
          type: "resource",
          resource: {
            uri: resourceUri,
            mimeType: file.mime_type,
            blob: arrayBufferToBase64(file.bytes),
          },
        }],
      };
    },
    readAnnotations,
  );

  registerMcpTool(server,
    "resolve_course",
    "Resolve a human Canvas course name, code, numeric ID, or same-origin Canvas course URL to matching numeric course IDs. Returns all plausible matches and marks ambiguous results; never invents an ID or silently chooses among ties.",
    { query: z.string().min(1).max(500).describe("Human course name, course code, numeric course ID, or same-origin https://<canvas>/courses/<id> URL.") },
    async ({ query }) => {
      const response = await canvasPaginate(config, { path: "/courses", query: { enrollment_state: "active", per_page: 100 }, maxPages: 10 });
      if (!response.ok) throw new Error(`Canvas course resolution failed with ${response.last_response.status}.`);
      const normalizedQuery = canvasCourseIdFromInput(query, config) ?? query.trim().toLowerCase();
      const matches = response.items
        .filter(isRecord)
        .map((course) => {
          const name = stringOrNull(course.name);
          const courseCode = stringOrNull(course.course_code);
          const sisCourseId = stringOrNull(course.sis_course_id);
          const canvasId = numericId(course.id)?.toString() ?? null;
          const terms = [canvasId, name, courseCode, sisCourseId].filter(Boolean).map((term) => term!.toLowerCase());
          const confidence = terms.some((term) => term === normalizedQuery)
            ? 1
            : terms.some((term) => term.startsWith(normalizedQuery))
              ? 0.9
              : terms.some((term) => term.includes(normalizedQuery))
                ? 0.75
                : 0;
          return {
            course_id: numericId(course.id),
            name,
            course_code: courseCode,
            sis_course_id: sisCourseId,
            confidence,
          };
        })
        .filter((course) => course.course_id !== null && course.confidence > 0)
        .sort((left, right) => right.confidence - left.confidence || (left.name ?? "").localeCompare(right.name ?? ""))
        .map((course) => ({ ...course, course_id: course.course_id! }));
      return jsonText({
        ok: true,
        query,
        ambiguous: matches.length > 1 && matches[0]?.confidence === matches[1]?.confidence,
        matches,
        read_metadata: mcpReadMetadata({ source: "live", fetchedAt: new Date().toISOString(), totalCount: matches.length }),
      });
    },
    readAnnotations,
  );

  registerMcpTool(server,
    "get_course_dashboard",
    "Return a compact live Canvas course snapshot with assignments, missing submissions, and announcements. Use after resolving the course ID; this compound read returns data from the configured Canvas instance.",
    {
      course_id: z.union([z.string().min(1), z.number().int()]),
      user_id: z.union([z.string().min(1), z.number().int()]).optional().default("self"),
    },
    async ({ course_id, user_id }) => {
      const courseId = String(course_id);
      const numericCourseId = numericId(courseId);
      if (numericCourseId === null) throw new Error("course_id must be a numeric Canvas course ID.");
      const [assignments, missing, announcements] = await Promise.all([
        canvasPaginate(config, { path: `/courses/${encodeURIComponent(courseId)}/assignments`, maxPages: 10 }),
        canvasPaginate(config, { path: `/users/${encodeURIComponent(String(user_id))}/missing_submissions`, query: { course_id: courseId }, maxPages: 10 }),
        canvasPaginate(config, { path: "/announcements", query: { context_codes: [`course_${courseId}`], latest_only: true }, maxPages: 3 }),
      ]);
      for (const [label, result] of [["assignments", assignments], ["missing_submissions", missing], ["announcements", announcements]] as const) {
        if (!result.ok) throw new Error(`Canvas course dashboard ${label} request failed with ${result.last_response.status}.`);
      }
      return jsonText({
        ok: true,
        course_id: numericCourseId,
        assignments: assignments.items,
        missing_submissions: missing.items,
        announcements: announcements.items,
        assignment_pagination: assignments.pagination,
        missing_submission_pagination: missing.pagination,
        announcement_pagination: announcements.pagination,
        read_metadata: mcpReadMetadata({ source: "live", fetchedAt: new Date().toISOString(), totalCount: assignments.items.length + missing.items.length + announcements.items.length }),
      });
    },
    readAnnotations,
  );

  for (const definition of TOP_30_TOOLS) {
    registerTop30Tool(server, config, definition);
  }

  setMcpToolOutputSchemas(server, {
    ...canvasOutputSchemas,
    ...Object.fromEntries(
      TOP_30_TOOLS.map((tool) => [
        tool.name,
        tool.name === "get_course_file_download" ? canvasFileRawOutputSchema : canvasResponseOutputSchema,
      ]),
    ),
  });

  return server;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numericId(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function canvasCourseIdFromInput(input: string, config: RuntimeConfig): string | null {
  if (!/^https?:\/\//i.test(input.trim())) return null;
  try {
    const url = new URL(input.trim());
    if (url.origin !== config.canvasOrigin || url.protocol !== "https:") return null;
    const match = url.pathname.match(/^\/courses\/(\d+)(?:\/|$)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function diagnosticOptionsFromCanvasRequest(
  query: QueryParams | undefined,
  body: unknown,
): {
  path: string;
  query?: QueryParams;
  profiles?: CanvasProbeProfile[];
  includeAuthorization?: boolean[];
} {
  const bodyRecord = isRecord(body) ? body : {};
  const rawQuery = { ...(query ?? {}) };
  const targetPath =
    stringValue(bodyRecord.path) ??
    stringValue(bodyRecord.target_path) ??
    stringValue(rawQuery.target_path) ??
    "/courses";

  delete rawQuery.target_path;
  delete rawQuery.profiles;
  delete rawQuery.include_authorization;

  const targetQuery =
    isRecord(bodyRecord.query) ? (bodyRecord.query as QueryParams) : rawQuery;

  const options: {
    path: string;
    query?: QueryParams;
    profiles?: CanvasProbeProfile[];
    includeAuthorization?: boolean[];
  } = {
    path: targetPath,
  };

  if (Object.keys(targetQuery).length > 0) options.query = targetQuery;

  const profiles = parseProbeProfiles(bodyRecord.profiles ?? query?.profiles);
  if (profiles.length > 0) options.profiles = profiles;

  const authModes = parseBooleanArray(bodyRecord.include_authorization ?? query?.include_authorization);
  if (authModes.length > 0) options.includeAuthorization = authModes;

  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseProbeProfiles(value: unknown): CanvasProbeProfile[] {
  const allowed = new Set<CanvasProbeProfile>([
    "configured",
    "canvas_json",
    "browser_json",
    "browser_navigation",
    "browser_sec_fetch",
    "curl_json",
    "minimal",
    "no_user_agent",
    "no_accept",
  ]);
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  return values
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry): entry is CanvasProbeProfile => allowed.has(entry as CanvasProbeProfile));
}

function parseBooleanArray(value: unknown): boolean[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const out: boolean[] = [];
  for (const entry of values) {
    if (typeof entry === "boolean") out.push(entry);
    if (typeof entry === "string") {
      const normalized = entry.trim().toLowerCase();
      if (["1", "true", "yes", "with", "auth"].includes(normalized)) out.push(true);
      if (["0", "false", "no", "without", "noauth"].includes(normalized)) out.push(false);
    }
  }
  return [...new Set(out)];
}

function registerTop30Tool(
  server: McpServer,
  config: RuntimeConfig,
  definition: Top30ToolDefinition,
): void {
  const schema: Record<string, z.ZodType> = {};
  for (const param of definition.pathParams) {
    schema[param] = z.union([z.string().min(1), z.number().int()]);
  }
  Object.assign(schema, definition.querySchema);

  registerMcpTool(server, definition.name, definition.description, schema, async (args) => {
    if (definition.name === "get_course_file_download") {
      // Canvas does not serve this as a course-scoped API endpoint. The file
      // metadata endpoint returns the signed download URL, which is the same
      // safe, origin-checked path used by the dedicated file tools.
      fillPath(definition.path, definition.pathParams, args as Record<string, unknown>);
      return jsonText(await getCanvasFileRaw(config, (args as Record<string, unknown>).file_id as string | number));
    }

    const path = fillPath(definition.path, definition.pathParams, args as Record<string, unknown>);
    const query = collectQuery(definition, args as Record<string, unknown>);
    if (hasPerPageQuery(definition) && query.per_page === undefined) query.per_page = 100;

    const requestOptions: {
      method: "GET";
      path: string;
      query: QueryParams;
      responseMode?: ResponseMode;
    } = { method: "GET", path, query };

    if (definition.responseMode !== undefined) {
      requestOptions.responseMode = definition.responseMode;
    }

    return jsonText(await canvasRequest(config, requestOptions));
  }, readAnnotations);
}

function fillPath(
  template: string,
  pathParams: string[],
  args: Record<string, unknown>,
): string {
  let path = template;
  for (const param of pathParams) {
    const value = args[param];
    if (value === undefined || value === null || value === "") {
      throw new Error(`Missing required path parameter: ${param}`);
    }
    path = path.replace(`{${param}}`, encodeURIComponent(String(value)));
  }
  return path;
}

function collectQuery(
  definition: Top30ToolDefinition,
  args: Record<string, unknown>,
): QueryParams {
  const pathParamSet = new Set(definition.pathParams);
  const out: QueryParams = {};

  for (const key of Object.keys(definition.querySchema)) {
    if (pathParamSet.has(key)) continue;
    const value = args[key];
    if (value === undefined || value === null || value === "") continue;
    out[key] = value as QueryParams[string];
  }

  return out;
}

function hasPerPageQuery(definition: Top30ToolDefinition): boolean {
  return Object.hasOwn(definition.querySchema, "per_page");
}
