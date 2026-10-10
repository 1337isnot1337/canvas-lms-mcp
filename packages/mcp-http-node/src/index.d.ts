import type { Express, Request } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type McpHttpMetadata = {
  id: string;
  version: string;
  buildId?: string | null;
  readOnly?: boolean;
  commit?: string | null;
  builtAt?: string | null;
  lastUpdatedAt?: string | null;
};

export declare function createMcpAuthenticator(options?: {
  token?: string | undefined;
  querySecret?: string | undefined;
  allowQueryKey?: boolean | undefined;
}): (request: Request) => boolean;

export declare function registerMcpHealthRoutes(
  app: Express,
  metadata: McpHttpMetadata,
  options?: {
    path?: string;
    readyPath?: string;
    readyCheck?: () =>
      | { ok: boolean; details?: unknown }
      | Promise<{ ok: boolean; details?: unknown }>;
  },
): void;

export declare function createMcpHttpRuntime(options: {
  metadata: McpHttpMetadata;
  host?: string;
  route?: string;
  allowedHosts?: string[];
  maxRequestBytes?: number | string;
  requestsPerMinute?: number;
  maxConcurrentRequests?: number;
  requestTimeoutMs?: number;
  allowJsonOnlyAccept?: boolean;
  toolAliases?: Record<string, string>;
  authenticate?: (request: Request) => boolean | Promise<boolean>;
  createServer: (context?: { requestId: string; signal: AbortSignal }) => McpServer;
}): {
  app: Express;
  errorHandler: (error: unknown, request: Request, response: any, next: (error?: unknown) => void) => void;
  notFoundHandler: (request: Request, response: any) => void;
  listen: (port: number, callback?: () => void) => any;
};
