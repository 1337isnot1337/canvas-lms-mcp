import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export declare const MCP_CORE_VERSION: string;
export declare const MCP_CONTRACT_VERSION: number;

export type McpMetadata = {
  id: string;
  version: string;
  buildId?: string | null;
  commit?: string | null;
  builtAt?: string | null;
  lastUpdatedAt?: string | null;
  readOnly?: boolean;
  description?: string;
  useWhen?: string[];
  notFor?: string[];
  authoritativeFor?: string[];
  relatedServices?: string[];
  routingNotes?: string[];
  instructions?: string;
};

export type McpToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations: ToolAnnotations & {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
  category?: string;
  requiresConfirmation?: boolean;
  externalMutation?: boolean;
  sideEffects?: string;
  _meta?: Record<string, unknown>;
};

export type McpToolDescriptor = {
  name: string;
  description: string;
  read_only: boolean;
  destructive: boolean;
  open_world: boolean;
  idempotent: boolean;
  category: string;
  requires_confirmation: boolean;
  external_mutation: boolean;
  side_effects: string | null;
};

export declare function createBaseMcpServer(metadata: McpMetadata): McpServer;

export declare function registerMcpTool(
  server: McpServer,
  name: string,
  config: McpToolConfig,
  handler: (...args: any[]) => any,
): RegisteredTool;

export declare function registerMcpTool(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: unknown,
  annotations: ToolAnnotations & {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  },
  handler: (...args: any[]) => any,
): RegisteredTool;

export declare function registerMcpTool(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: unknown,
  handler: (...args: any[]) => any,
  annotations: ToolAnnotations & {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  },
  category?: string,
  requiresConfirmation?: boolean,
): RegisteredTool;

export declare function runMcpRequestContext<T>(
  context: { requestId: string; signal: AbortSignal },
  work: () => T | Promise<T>,
): T | Promise<T>;

export declare function getMcpRequestContext():
  | { requestId: string; signal: AbortSignal }
  | undefined;

export declare function setMcpToolOutputSchemas(
  server: McpServer,
  schemas: Record<string, unknown>,
): void;

export declare function getMcpToolCatalog(server: McpServer): McpToolDescriptor[];

export type McpManifestFingerprints = {
  manifest_hash: string;
  tool_manifest_sha256: string;
  connector_metadata_sha256: string;
};

export declare function getMcpManifestFingerprints(server: McpServer): McpManifestFingerprints;

export type McpLastUpdated = {
  last_updated_at: string | null;
  last_updated_human: string;
  last_updated_unix: number | null;
  last_updated_source: "release_metadata" | "runtime_metadata" | "build_metadata" | "unavailable";
};

export declare function getMcpLastUpdated(metadata?: Pick<McpMetadata, "lastUpdatedAt" | "builtAt">): McpLastUpdated;

export type McpFreshness = {
  source: "live" | "cache" | "derived" | "unknown";
  fetched_at: string | null;
  read_at: string;
  age_seconds: number | null;
  freshness: "fresh" | "stale" | "unknown";
};

export type McpPagination = {
  has_more: boolean;
  next_cursor: string | null;
  total_count: number | null;
  truncated: boolean;
};

export declare function mcpFreshness(options?: {
  source?: McpFreshness["source"] | string;
  fetchedAt?: string | number | Date | null;
  maxAgeMs?: number;
  now?: string | number | Date;
}): McpFreshness;

export declare function mcpPagination(options?: {
  hasMore?: boolean;
  nextCursor?: string | number | null;
  totalCount?: number | null;
  truncated?: boolean;
}): McpPagination;

export declare function mcpReadMetadata(options?: {
  source?: McpFreshness["source"] | string;
  fetchedAt?: string | number | Date | null;
  maxAgeMs?: number;
  now?: string | number | Date;
  hasMore?: boolean;
  nextCursor?: string | number | null;
  totalCount?: number | null;
  truncated?: boolean;
}): McpFreshness & { pagination: McpPagination };

export type McpToolContract = McpToolDescriptor & {
  annotations: ToolAnnotations;
  input_schema: unknown;
  output_schema: unknown;
};

export declare function getMcpToolContracts(server: McpServer): McpToolContract[];

export type McpToolDefinition = McpToolDescriptor & {
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: ToolAnnotations;
  handler: (...args: any[]) => any;
};

export declare function getMcpToolDefinitions(server: McpServer): McpToolDefinition[];

export declare function toStructuredContent(value: unknown): Record<string, unknown>;

export declare function mcpResult(value: unknown): {
  isError?: true;
  structuredContent: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
};

export declare function mcpErrorResult(
  error: unknown,
  options?: {
    code?: string;
    retryable?: boolean;
    userActionRequired?: boolean;
    providerStatus?: number | null;
    retryAfterSeconds?: number | null;
    requestId?: string | null;
    details?: unknown;
    maxMessageLength?: number;
  },
): {
  isError: true;
  structuredContent: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
};

export declare function safeMcpCall(
  work: () => unknown | Promise<unknown>,
  options?: { code?: string; retryable?: boolean; details?: unknown },
): Promise<unknown>;

export declare function createMcpRelease<T extends McpMetadata>(release: T): Readonly<T>;
