import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const API_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const RESPONSE_MODES = new Set(["auto", "json", "text", "base64"]);
const PROBE_PROFILES = new Set([
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
const MAX_REQUEST_BYTES = 256 * 1024;

function boolFromEnv(value, defaultValue) {
  if (!value || !value.trim()) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function intFromEnv(value, defaultValue) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function normalizeHttpsOrigin(value, name) {
  const parsed = new URL(value ?? "");
  if (parsed.protocol !== "https:") throw new Error(`${name} must use https://`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must not include credentials, a query, or a fragment.`);
  }
  return parsed.origin;
}

export function loadConfig(env = process.env) {
  env = { ...env };
  for (const key of ["CANVAS_TOKEN", "RELAY_SHARED_SECRET"]) {
    if (env[`${key}_FILE`]?.trim()) {
      env[key] = readFileSync(env[`${key}_FILE`].trim(), "utf8").trim();
    }
  }
  const canvasBaseUrl = normalizeHttpsOrigin(env.CANVAS_BASE_URL, "CANVAS_BASE_URL");
  const canvasToken = env.CANVAS_TOKEN?.trim() ?? "";
  const relaySecret = env.RELAY_SHARED_SECRET?.trim() ?? "";

  if (canvasToken.length < 10) throw new Error("CANVAS_TOKEN must be set.");
  if (relaySecret.length < 32) throw new Error("RELAY_SHARED_SECRET must be at least 32 characters long.");

  return {
    canvasBaseUrl,
    canvasOrigin: new URL(canvasBaseUrl).origin,
    canvasToken,
    relaySecret,
    canvasUserAgent:
      env.CANVAS_USER_AGENT?.trim() ||
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 CanvasMCP/0.1.0",
    canvasAccept: env.CANVAS_ACCEPT?.trim() || "application/json, text/plain, */*",
    canvasAcceptLanguage: env.CANVAS_ACCEPT_LANGUAGE?.trim() || "en-US,en;q=0.9",
    readOnly: boolFromEnv(env.READ_ONLY, true),
    maxApiResponseBytes: intFromEnv(env.MAX_API_RESPONSE_BYTES, 2_000_000),
    maxFileBytes: intFromEnv(env.MAX_FILE_BYTES, 10_000_000),
  };
}

export function loadListenConfig(env = process.env) {
  const port = intFromEnv(env.PORT, 8300);
  if (port > 65535) throw new Error("PORT must be between 1 and 65535.");

  return {
    host: env.HOST?.trim() || "::",
    port,
  };
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function authorized(request, secret) {
  const value = request.headers.authorization;
  const expected = `Bearer ${secret}`;
  if (typeof value !== "string" || value.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

async function readRequestJson(request) {
  const contentLength = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "Relay request body is too large.");
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new HttpError(413, "Relay request body is too large.");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Relay request body must be valid JSON.");
  }
}

function assertRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Relay request body must be a JSON object.");
  }
  return value;
}

function validateCanvasApiUrl(config, value) {
  if (typeof value !== "string") throw new HttpError(400, "url must be a string.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== config.canvasOrigin) {
    throw new HttpError(400, "Only the configured Canvas origin is allowed.");
  }
  if (url.username || url.password || (!url.pathname.startsWith("/api/v1/") && url.pathname !== "/api/v1")) {
    throw new HttpError(400, "Only Canvas API URLs under /api/v1 are allowed.");
  }
  return url;
}

function validateDownloadUrl(config, value) {
  if (typeof value !== "string") throw new HttpError(400, "url must be a string.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== config.canvasOrigin) {
    throw new HttpError(400, "Only the configured Canvas origin is allowed.");
  }
  if (url.username || url.password || !url.pathname.startsWith("/files/")) {
    throw new HttpError(400, "Only Canvas file download URLs under /files are allowed.");
  }
  return url;
}

function canvasHeaders(config, includeAuthorization = true) {
  const headers = new Headers({
    Accept: config.canvasAccept,
    "Accept-Language": config.canvasAcceptLanguage,
    "User-Agent": config.canvasUserAgent,
  });
  if (includeAuthorization) headers.set("Authorization", `Bearer ${config.canvasToken}`);
  return headers;
}

function probeHeaders(config, profile, includeAuthorization) {
  const headers = new Headers();
  if (includeAuthorization) headers.set("Authorization", `Bearer ${config.canvasToken}`);

  switch (profile) {
    case "configured":
      return canvasHeaders(config, includeAuthorization);
    case "canvas_json":
      headers.set("Accept", "application/json");
      headers.set("User-Agent", "CanvasMCP/0.1.0");
      break;
    case "browser_json":
      headers.set("Accept", "application/json, text/plain, */*");
      headers.set("Accept-Language", "en-US,en;q=0.9");
      headers.set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
      break;
    case "browser_navigation":
      headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7");
      headers.set("Accept-Language", "en-US,en;q=0.9");
      headers.set("Upgrade-Insecure-Requests", "1");
      headers.set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
      break;
    case "browser_sec_fetch":
      headers.set("Accept", "application/json, text/plain, */*");
      headers.set("Accept-Language", "en-US,en;q=0.9");
      headers.set("Sec-Fetch-Dest", "empty");
      headers.set("Sec-Fetch-Mode", "cors");
      headers.set("Sec-Fetch-Site", "none");
      headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
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
    default:
      throw new HttpError(400, "Unsupported probe profile.");
  }

  return headers;
}

function sanitizeHeaders(headers) {
  const output = {};
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "authorization") output[key] = "Bearer <redacted>";
    else output[key] = value;
  });
  return output;
}

function sanitizeResponseHeaders(headers) {
  const output = {};
  headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") output[key] = value;
  });
  return output;
}

async function readCapped(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(413, `Canvas response exceeds configured byte limit (${maxBytes}).`);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, `Canvas response exceeds configured byte limit (${maxBytes}).`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function classifyProbe(response, bodyPreview) {
  const contentType = response.headers.get("content-type") ?? "";
  const body = bodyPreview.toLowerCase();
  if (response.ok && contentType.includes("json")) return "canvas_api_json_ok";
  if (contentType.includes("json")) return "canvas_api_json_error";
  if (body.includes("valid user agent")) return "missing_or_rejected_user_agent";
  if (response.status === 406 && contentType.includes("html")) return "apache_or_edge_406";
  if (contentType.includes("html")) return "html_edge_or_proxy_response";
  return "unclassified_non_json_response";
}

async function parseCanvasResponse(config, response, responseMode) {
  const contentType = response.headers.get("content-type");
  const base = {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    contentType,
    link: response.headers.get("link"),
  };
  if (response.status === 204 || !response.body) return { ...base, data: null };

  const shouldReadBase64 =
    responseMode === "base64" ||
    (responseMode === "auto" && contentType && !contentType.includes("json") && !contentType.startsWith("text/"));
  const bytes = await readCapped(response, shouldReadBase64 ? config.maxFileBytes : config.maxApiResponseBytes);

  if (shouldReadBase64) return { ...base, data: bytes.toString("base64"), encoding: "base64" };

  const text = bytes.toString("utf8");
  if (!text) return { ...base, data: null };
  if (responseMode !== "text" && (responseMode === "json" || contentType?.includes("json"))) {
    try {
      return { ...base, data: JSON.parse(text) };
    } catch {
      return { ...base, data: text };
    }
  }
  return { ...base, data: text };
}

async function handleCanvas(config, fetchImpl, body) {
  const payload = assertRecord(body);
  const url = validateCanvasApiUrl(config, payload.url);
  const method = typeof payload.method === "string" ? payload.method.toUpperCase() : "GET";
  const responseMode = typeof payload.response_mode === "string" ? payload.response_mode : "auto";
  if (!API_METHODS.has(method)) throw new HttpError(400, "Unsupported Canvas HTTP method.");
  if (!RESPONSE_MODES.has(responseMode)) throw new HttpError(400, "Unsupported response mode.");
  if (config.readOnly && !READ_METHODS.has(method)) {
    return {
      ok: false,
      status: 403,
      statusText: "Read-only mode",
      url: url.toString(),
      contentType: "application/json",
      link: null,
      data: { error: `READ_ONLY=true blocks ${method} requests.` },
    };
  }

  const headers = canvasHeaders(config);
  const init = { method, headers, redirect: "follow" };
  if (payload.body !== undefined && method !== "GET" && method !== "HEAD") {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(payload.body);
  }
  return parseCanvasResponse(config, await fetchImpl(url, init), responseMode);
}

async function handleProbe(config, fetchImpl, body) {
  const payload = assertRecord(body);
  const url = validateCanvasApiUrl(config, payload.url);
  const profile = payload.profile;
  const includeAuthorization = payload.include_authorization;
  if (typeof profile !== "string" || !PROBE_PROFILES.has(profile)) {
    throw new HttpError(400, "Unsupported probe profile.");
  }
  if (typeof includeAuthorization !== "boolean") {
    throw new HttpError(400, "include_authorization must be a boolean.");
  }

  const headers = probeHeaders(config, profile, includeAuthorization);
  const response = await fetchImpl(url, { method: "GET", headers, redirect: "follow" });
  const bytes = await readCapped(response, 4096);
  const bodyPreview = bytes.toString("utf8").slice(0, 4096);
  return {
    profile,
    include_authorization: includeAuthorization,
    request_headers: sanitizeHeaders(headers),
    response_headers: sanitizeResponseHeaders(response.headers),
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    contentType: response.headers.get("content-type"),
    body_preview: bodyPreview,
    classification: classifyProbe(response, bodyPreview),
  };
}

async function handleDownload(config, fetchImpl, body) {
  const payload = assertRecord(body);
  const url = validateDownloadUrl(config, payload.url);
  const response = await fetchImpl(url, {
    headers: canvasHeaders(config),
    redirect: "follow",
  });
  if (!response.ok) {
    const preview = (await readCapped(response, 4096)).toString("utf8").slice(0, 300);
    throw new HttpError(response.status, `Canvas file download failed${preview ? `: ${preview}` : "."}`);
  }
  return { bytes: await readCapped(response, config.maxFileBytes), response };
}

export function createRelayServer({ config = loadConfig(), fetchImpl = fetch } = {}) {
  return createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://relay.invalid").pathname;
    try {
      if (request.method === "GET" && path === "/healthz") {
        json(response, 200, { ok: true, service: "canvas-relay" });
        return;
      }

      if (!authorized(request, config.relaySecret)) {
        json(response, 401, { ok: false, error: "Unauthorized" });
        return;
      }

      if (request.method === "GET" && path === "/v1/health") {
        json(response, 200, { ok: true, service: "canvas-relay" });
        return;
      }

      if (request.method !== "POST") {
        json(response, 404, { ok: false, error: "Not found" });
        return;
      }

      const body = await readRequestJson(request);
      if (path === "/v1/canvas") {
        json(response, 200, await handleCanvas(config, fetchImpl, body));
        return;
      }
      if (path === "/v1/probe") {
        json(response, 200, await handleProbe(config, fetchImpl, body));
        return;
      }
      if (path === "/v1/download") {
        const downloaded = await handleDownload(config, fetchImpl, body);
        const headers = {
          "content-type": downloaded.response.headers.get("content-type") || "application/octet-stream",
          "content-length": String(downloaded.bytes.byteLength),
          "cache-control": "no-store",
        };
        const disposition = downloaded.response.headers.get("content-disposition");
        if (disposition) headers["content-disposition"] = disposition;
        response.writeHead(200, headers);
        response.end(downloaded.bytes);
        return;
      }

      json(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Unexpected relay error.";
      if (status >= 500) console.error(error);
      json(response, status, { ok: false, error: message });
    }
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadConfig();
  const listen = loadListenConfig();
  const server = createRelayServer({ config });
  server.listen(listen.port, listen.host, () => {
    console.log(`Canvas relay listening on [${listen.host}]:${listen.port}`);
  });

  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      console.log(`Canvas relay received ${signal}; shutting down.`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10_000).unref();
    });
  }
}
