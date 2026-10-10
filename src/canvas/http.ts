import type { RuntimeConfig } from "../config";
import { mcpReadMetadata } from "@canvas-lms-mcp/mcp-core";
import {
  canvasRelayProbe,
  canvasRelayRequest,
} from "./relay";

export type CanvasMethod = "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ResponseMode = "auto" | "json" | "text" | "base64";
export type QueryValue = string | number | boolean | Array<string | number | boolean> | null | undefined;
export type QueryParams = Record<string, QueryValue>;

export type CanvasRequestOptions = {
  method?: CanvasMethod;
  path: string;
  query?: QueryParams;
  body?: unknown;
  responseMode?: ResponseMode;
};

export type CanvasResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  contentType: string | null;
  link: string | null;
  data: unknown;
  truncated?: boolean;
  encoding?: "base64";
  source?: "live" | "cache" | "derived" | "unknown";
  fetched_at?: string | null;
  read_at?: string;
  age_seconds?: number | null;
  freshness?: "fresh" | "stale" | "unknown";
  pagination?: ReturnType<typeof mcpReadMetadata>["pagination"];
};

export type CanvasProbeProfile =
  | "configured"
  | "canvas_json"
  | "browser_json"
  | "browser_navigation"
  | "browser_sec_fetch"
  | "curl_json"
  | "minimal"
  | "no_user_agent"
  | "no_accept";

export type CanvasHeaderProbeResult = {
  profile: CanvasProbeProfile;
  include_authorization: boolean;
  request_headers: Record<string, string>;
  response_headers: Record<string, string>;
  status: number;
  statusText: string;
  url: string;
  contentType: string | null;
  body_preview: string;
  classification: string;
};

const READ_METHODS = new Set<CanvasMethod>(["GET", "HEAD", "OPTIONS"]);
const ALL_METHODS = new Set<CanvasMethod>(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);

function getNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === "next") return match[1] ?? null;
  }
  return null;
}

export function normalizeCanvasMethod(method: string | undefined): CanvasMethod {
  const normalized = (method ?? "GET").trim().toUpperCase();
  if (!ALL_METHODS.has(normalized as CanvasMethod)) {
    throw new Error(`Unsupported Canvas HTTP method: ${method}`);
  }
  return normalized as CanvasMethod;
}

export function isReadMethod(method: CanvasMethod): boolean {
  return READ_METHODS.has(method);
}

export function normalizeCanvasApiPath(path: string, baseUrl?: string): string {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("Canvas API path is required.");
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) {
    if (!baseUrl) throw new Error("Canvas API path must be relative, or provide a same-origin Canvas API URL.");
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error("Canvas API URL is invalid.");
    }
    const base = new URL(baseUrl);
    if (parsed.origin !== base.origin) {
      throw new Error(`Canvas API URL must use the configured Canvas origin: ${base.origin}`);
    }
    if (parsed.pathname !== "/api/v1" && !parsed.pathname.startsWith("/api/v1/")) {
      throw new Error(`Canvas URL must point to the /api/v1 API: ${parsed.pathname}`);
    }
    if (parsed.username || parsed.password) {
      throw new Error("Canvas API URL must not include credentials.");
    }
    parsed.hash = "";
    return `${parsed.pathname}${parsed.search}`;
  }
  if (trimmed.includes("\\")) {
    throw new Error("Canvas API path must not contain backslashes.");
  }

  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash === "/api/v1" || withSlash.startsWith("/api/v1/")) return withSlash;
  return `/api/v1${withSlash}`;
}

export function appendQuery(url: URL, query: QueryParams = {}): void {
  for (const [rawKey, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;

    if (Array.isArray(value)) {
      const key = rawKey.endsWith("[]") ? rawKey : `${rawKey}[]`;
      for (const item of value) {
        if (item === undefined || item === null || item === "") continue;
        url.searchParams.append(key, String(item));
      }
      continue;
    }

    url.searchParams.set(rawKey, String(value));
  }
}

export function buildCanvasApiUrl(config: RuntimeConfig, path: string, query?: QueryParams): URL {
  const url = new URL(normalizeCanvasApiPath(path, config.canvasBaseUrl), config.canvasBaseUrl);
  appendQuery(url, query);
  return url;
}

export function validateCanvasUrl(config: RuntimeConfig, url: URL): void {
  if (url.origin !== config.canvasOrigin) {
    throw new Error(`Refusing to call non-Canvas origin: ${url.origin}`);
  }
  if (!url.pathname.startsWith("/api/v1/") && url.pathname !== "/api/v1") {
    throw new Error(`Refusing non-Canvas API path: ${url.pathname}`);
  }
}

export function canvasFetchHeaders(config: RuntimeConfig): Headers {
  const headers = new Headers({
    Accept: config.canvasAccept,
    "Accept-Language": config.canvasAcceptLanguage,
    "User-Agent": config.canvasUserAgent,
  });
  if (config.canvasToken) headers.set("Authorization", `Bearer ${config.canvasToken}`);
  return headers;
}

export function canvasProbeHeaders(
  config: RuntimeConfig,
  profile: CanvasProbeProfile,
  includeAuthorization: boolean,
): Headers {
  const headers = new Headers();

  if (includeAuthorization) {
    headers.set("Authorization", `Bearer ${config.canvasToken}`);
  }

  switch (profile) {
    case "configured":
      return withOptionalAuthorization(canvasFetchHeaders(config), config, includeAuthorization);
    case "canvas_json":
      headers.set("Accept", "application/json");
      headers.set("User-Agent", "CanvasMCP/0.1.0");
      break;
    case "browser_json":
      headers.set("Accept", "application/json, text/plain, */*");
      headers.set("Accept-Language", "en-US,en;q=0.9");
      headers.set(
        "User-Agent",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      );
      break;
    case "browser_navigation":
      headers.set(
        "Accept",
        "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
      );
      headers.set("Accept-Language", "en-US,en;q=0.9");
      headers.set("Upgrade-Insecure-Requests", "1");
      headers.set(
        "User-Agent",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      );
      break;
    case "browser_sec_fetch":
      headers.set("Accept", "application/json, text/plain, */*");
      headers.set("Accept-Language", "en-US,en;q=0.9");
      headers.set("Sec-Fetch-Dest", "empty");
      headers.set("Sec-Fetch-Mode", "cors");
      headers.set("Sec-Fetch-Site", "none");
      headers.set(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      );
      break;
    case "curl_json":
      headers.set("Accept", "application/json, */*");
      headers.set("User-Agent", "curl/8.5.0");
      break;
    case "minimal":
      headers.set("Accept", "*/*");
      break;
    case "no_user_agent":
      headers.set("Accept", "application/json, text/plain, */*");
      break;
    case "no_accept":
      headers.set("User-Agent", config.canvasUserAgent);
      break;
  }

  return headers;
}

function withOptionalAuthorization(
  headers: Headers,
  config: RuntimeConfig,
  includeAuthorization: boolean,
): Headers {
  if (includeAuthorization) {
    headers.set("Authorization", `Bearer ${config.canvasToken}`);
  } else {
    headers.delete("Authorization");
  }
  return headers;
}

export function sanitizedCanvasHeaders(config: RuntimeConfig): Record<string, string> {
  const headers = canvasFetchHeaders(config);
  return sanitizeHeaders(headers);
}

export function sanitizeHeaders(headers: Headers): Record<string, string> {
  if (headers.has("Authorization")) {
    headers.set("Authorization", "Bearer <redacted>");
  }
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function sanitizeResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    out[key] = value;
  });
  return out;
}

const SENSITIVE_CANVAS_KEYS = new Set([
  "secure_params",
  "access_token",
  "refresh_token",
  "client_secret",
  "authorization",
]);

/** Remove credential-like fields from JSON returned by Canvas or its relay. */
export function sanitizeCanvasData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeCanvasData);
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_CANVAS_KEYS.has(key.toLowerCase())) continue;
    result[key] = sanitizeCanvasData(nested);
  }
  return result;
}

export async function canvasHeaderProbe(
  config: RuntimeConfig,
  options: {
    path: string;
    query?: QueryParams;
    profiles?: CanvasProbeProfile[];
    includeAuthorization?: boolean[];
  },
): Promise<{ ok: boolean; url: string; results: CanvasHeaderProbeResult[] } & ReturnType<typeof mcpReadMetadata>> {
  const url = buildCanvasApiUrl(config, options.path, options.query);
  validateCanvasUrl(config, url);

  const profiles = options.profiles ?? [
    "configured",
    "canvas_json",
    "browser_json",
    "browser_navigation",
    "browser_sec_fetch",
    "curl_json",
    "minimal",
    "no_user_agent",
    "no_accept",
  ];
  const authModes = options.includeAuthorization ?? [false, true];
  const results: CanvasHeaderProbeResult[] = [];

  for (const profile of profiles) {
    for (const includeAuthorization of authModes) {
      if (config.canvasRelay) {
        results.push(
          await canvasRelayProbe(config, {
            url,
            profile,
            includeAuthorization,
          }),
        );
        continue;
      }

      const headers = canvasProbeHeaders(config, profile, includeAuthorization);
      const response = await fetch(url, { method: "GET", headers, redirect: "follow" });
      const bodyPreview = (await readTextCapped(response, 4096)).slice(0, 4096);
      results.push({
        profile,
        include_authorization: includeAuthorization,
        request_headers: sanitizeHeaders(new Headers(headers)),
        response_headers: sanitizeResponseHeaders(response.headers),
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        contentType: response.headers.get("content-type"),
        body_preview: bodyPreview,
        classification: classifyCanvasProbeResponse(response, bodyPreview),
      });
    }
  }

  return {
    ok: results.some((result) => result.status !== 406),
    url: url.toString(),
    results,
    ...mcpReadMetadata({ source: "live", fetchedAt: new Date().toISOString(), totalCount: results.length }),
  };
}

function classifyCanvasProbeResponse(response: Response, bodyPreview: string): string {
  const contentType = response.headers.get("content-type") ?? "";
  const body = bodyPreview.toLowerCase();

  if (response.ok && contentType.includes("json")) return "canvas_api_json_ok";
  if (contentType.includes("json")) return "canvas_api_json_error";
  if (body.includes("valid user agent")) return "missing_or_rejected_user_agent";
  if (response.status === 406 && contentType.includes("html")) return "apache_or_edge_406";
  if (contentType.includes("html")) return "html_edge_or_proxy_response";
  return "unclassified_non_json_response";
}

export async function canvasRequest(
  config: RuntimeConfig,
  options: CanvasRequestOptions,
): Promise<CanvasResponse> {
  const method = normalizeCanvasMethod(options.method);
  if (config.readOnly && !isReadMethod(method)) {
    return {
      ok: false,
      status: 403,
      statusText: "Read-only mode",
      url: "",
      contentType: "application/json",
      link: null,
      data: {
        error: `READ_ONLY=true blocks ${method} requests. Set READ_ONLY=false to allow Canvas writes.`,
      },
      ...mcpReadMetadata({ source: "derived", fetchedAt: new Date().toISOString(), totalCount: 0 }),
    };
  }

  const url = buildCanvasApiUrl(config, options.path, options.query);
  return canvasRequestUrl(config, url, {
    method,
    body: options.body,
    responseMode: options.responseMode ?? "auto",
  });
}

export async function canvasRequestUrl(
  config: RuntimeConfig,
  url: URL,
  options: {
    method?: CanvasMethod;
    body?: unknown;
    responseMode?: ResponseMode;
  } = {},
): Promise<CanvasResponse> {
  validateCanvasUrl(config, url);

  const method = normalizeCanvasMethod(options.method);
  if (config.readOnly && !isReadMethod(method)) {
    return {
      ok: false,
      status: 403,
      statusText: "Read-only mode",
      url: url.toString(),
      contentType: "application/json",
      link: null,
      data: {
        error: `READ_ONLY=true blocks ${method} requests. Set READ_ONLY=false to allow Canvas writes.`,
      },
      ...mcpReadMetadata({ source: "derived", fetchedAt: new Date().toISOString(), totalCount: 0 }),
    };
  }

  if (config.canvasRelay) {
    const relayed = await canvasRelayRequest(config, {
      method,
      url,
      body: options.body,
      responseMode: options.responseMode ?? "auto",
    });
    return { ...relayed, data: sanitizeCanvasData(relayed.data) };
  }

  const headers = canvasFetchHeaders(config);

  const init: RequestInit = { method, headers, redirect: "follow" };
  if (options.body !== undefined && method !== "GET" && method !== "HEAD") {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, init);
  return parseCanvasResponse(config, response, options.responseMode ?? "auto");
}

async function parseCanvasResponse(
  config: RuntimeConfig,
  response: Response,
  responseMode: ResponseMode,
): Promise<CanvasResponse> {
  const contentType = response.headers.get("content-type");
  const link = response.headers.get("link");
  const nextLink = getNextLink(link);
  const fetchedAt = new Date().toISOString();
  const base = {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    contentType,
    link,
    ...mcpReadMetadata({ source: "live", fetchedAt, hasMore: nextLink !== null, nextCursor: nextLink, truncated: false }),
  };

  if (response.status === 204 || response.body === null) {
    return { ...base, data: null };
  }

  const shouldReadBase64 =
    responseMode === "base64" ||
    (responseMode === "auto" &&
      contentType !== null &&
      !contentType.includes("json") &&
      !contentType.startsWith("text/"));

  if (shouldReadBase64) {
    const bytes = await readArrayBufferCapped(response, config.maxFileBytes);
    return {
      ...base,
      data: arrayBufferToBase64(bytes),
      encoding: "base64",
    };
  }

  const text = await readTextCapped(response, config.maxApiResponseBytes);
  if (!text) return { ...base, data: null };

  if (responseMode !== "text" && (responseMode === "json" || contentType?.includes("json"))) {
    try {
      const data = sanitizeCanvasData(JSON.parse(text));
      return {
        ...base,
        data,
        pagination: mcpReadMetadata({
          source: "live",
          fetchedAt,
          hasMore: nextLink !== null,
          nextCursor: nextLink,
          totalCount: Array.isArray(data) ? data.length : null,
        }).pagination,
      };
    } catch {
      return { ...base, data: text };
    }
  }

  return { ...base, data: text };
}

export async function readTextCapped(response: Response, maxBytes: number): Promise<string> {
  const bytes = await readUint8ArrayCapped(response, maxBytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export async function readArrayBufferCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  return readUint8ArrayCapped(response, maxBytes);
}

async function readUint8ArrayCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new Error(`Response exceeds configured byte limit (${maxBytes}).`);
  }

  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeds configured byte limit (${maxBytes}).`);
    }
    chunks.push(value);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function arrayBufferToBase64(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}
