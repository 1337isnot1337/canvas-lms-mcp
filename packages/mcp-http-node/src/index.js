import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { getMcpLastUpdated, runMcpRequestContext } from "@canvas-lms-mcp/mcp-core";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

function constantTimeEqual(left, right) {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function headerValue(request, name) {
  const value = request.headers[name];
  return typeof value === "string" ? value : "";
}

function bearerValue(request) {
  const match = /^Bearer\s+(.+)$/i.exec(headerValue(request, "authorization"));
  return match?.[1]?.trim() ?? "";
}

function queryValue(request) {
  const values = new URL(request.url, "http://mcp.internal").searchParams.getAll("key");
  return values.length === 1 ? values[0] : "";
}

/**
 * Accept Bearer and X-MCP-Key credentials. Query credentials are optional
 * for clients without configurable request headers.
 */
export function createMcpAuthenticator({ token, querySecret, allowQueryKey = Boolean(querySecret) } = {}) {
  const expectedToken = String(token ?? "").trim();
  const expectedQuerySecret = String(querySecret ?? "").trim();
  return (request) => {
    const internal = headerValue(request, "x-mcp-key").trim();
    if (internal && expectedToken && constantTimeEqual(internal, expectedToken)) return true;

    const bearer = bearerValue(request);
    if (bearer && expectedToken && constantTimeEqual(bearer, expectedToken)) return true;

    const query = queryValue(request);
    if (
      allowQueryKey &&
      query &&
      expectedQuerySecret &&
      constantTimeEqual(query, expectedQuerySecret)
    ) return true;

    return false;
  };
}

function integerOption(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function requestId(request) {
  const supplied = headerValue(request, "x-request-id").trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/([?&]key=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(authorization\s*[:=]\s*|bearer\s+)[^,\s]+/gi, "$1[REDACTED]")
    .replace(/(x-mcp-key\s*[:=]\s*)[^,\s]+/gi, "$1[REDACTED]");
}

function sanitizeRequest(request) {
  const url = new URL(request.url, "http://mcp.internal");
  url.searchParams.delete("key");
  request.url = `${url.pathname}${url.search}`;
  if (typeof request.originalUrl === "string") {
    const original = new URL(request.originalUrl, "http://mcp.internal");
    original.searchParams.delete("key");
    request.originalUrl = `${original.pathname}${original.search}`;
  }
  delete request.headers.authorization;
  delete request.headers["x-mcp-key"];
}

function rewriteToolAliases(body, aliases) {
  if (!aliases || typeof aliases !== "object") return body;
  const rewrite = (message) => {
    if (!message || typeof message !== "object" || message.method !== "tools/call") return message;
    const name = message.params?.name;
    const replacement = typeof name === "string" ? aliases[name] : undefined;
    if (!replacement) return message;
    return {
      ...message,
      params: { ...message.params, name: replacement },
    };
  };
  return Array.isArray(body) ? body.map(rewrite) : rewrite(body);
}

function attachRequestId(request, response, next) {
  const id = requestId(request);
  request.mcpRequestId = id;
  response.set("x-request-id", id);
  next();
}

function securityHeaders(_request, response, next) {
  response.set({
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  next();
}

function errorHandler(serviceName) {
  return (error, request, response, next) => {
    response.set("x-request-id", request.mcpRequestId ?? requestId(request));
    if (error && typeof error === "object" && error.type === "entity.too.large") {
      response.status(413).json({ error: "MCP request exceeds MAX_REQUEST_BYTES." });
      return;
    }
    if (error instanceof SyntaxError) {
      response.status(400).json({ error: "Malformed JSON request body." });
      return;
    }
    if (response.headersSent) {
      next(error);
      return;
    }
    console.error(`[${serviceName}] unhandled HTTP error:`, safeErrorMessage(error));
    response.status(500).json({ error: "Internal server error." });
  };
}

function notFoundHandler(_request, response) {
  response.status(404).type("text/plain").send("Not found");
}

export function registerMcpHealthRoutes(app, metadata, options = {}) {
  const lastUpdated = getMcpLastUpdated(metadata);
  app.get(options.path ?? "/healthz", (_request, response) => {
    response.status(200).json({
      ok: true,
      schema_version: 1,
      service: metadata.id,
      version: metadata.version,
      build_id: metadata.buildId ?? null,
      last_updated_at: lastUpdated.last_updated_at,
      last_updated_human: lastUpdated.last_updated_human,
      last_updated_unix: lastUpdated.last_updated_unix,
      last_updated_source: lastUpdated.last_updated_source,
      read_only: metadata.readOnly ?? null,
    });
  });

  app.get(options.readyPath ?? "/readyz", async (_request, response, next) => {
    try {
      const result = options.readyCheck ? await options.readyCheck() : { ok: true };
      response.status(result.ok ? 200 : 503).json({
        ok: result.ok,
        schema_version: 1,
        service: metadata.id,
        version: metadata.version,
        build_id: metadata.buildId ?? null,
        last_updated_at: lastUpdated.last_updated_at,
        last_updated_human: lastUpdated.last_updated_human,
        last_updated_unix: lastUpdated.last_updated_unix,
        last_updated_source: lastUpdated.last_updated_source,
        read_only: metadata.readOnly ?? null,
        ...(result.details === undefined ? {} : { details: result.details }),
      });
    } catch (error) {
      next(error);
    }
  });
}

export function createMcpHttpRuntime(options) {
  const serviceName = String(options.metadata?.id ?? options.serviceName ?? "mcp-service");
  const host = options.host ?? "0.0.0.0";
  const route = options.route ?? "/mcp";
  const maxRequestBytes = options.maxRequestBytes ?? "2mb";
  const requestsPerMinute = integerOption(
    options.requestsPerMinute ?? process.env.MCP_MAX_REQUESTS_PER_MINUTE,
    120,
  );
  const maxConcurrentRequests = integerOption(
    options.maxConcurrentRequests ?? process.env.MCP_MAX_CONCURRENT_REQUESTS,
    8,
  );
  const requestTimeoutMs = integerOption(
    options.requestTimeoutMs ?? process.env.MCP_REQUEST_TIMEOUT_MS,
    65_000,
  );
  const allowJsonOnlyAccept = options.allowJsonOnlyAccept === true;
  const configuredHosts = String(process.env.ALLOWED_HOSTS ?? "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const allowedHosts = options.allowedHosts?.length
    ? options.allowedHosts
    : configuredHosts.length > 0
      ? configuredHosts
      : ["localhost", "127.0.0.1", "[::1]", serviceName];
  const allowedOrigins = new Set(String(process.env.ALLOWED_ORIGINS ?? "")
    .split(/[\s,]+/).filter(Boolean));

  const app = express();
  app.disable("x-powered-by");
  app.use(attachRequestId);
  app.use(hostHeaderValidation(allowedHosts));
  app.use(securityHeaders);
  app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (origin !== undefined && (typeof origin !== "string" || !allowedOrigins.has(origin))) {
      response.status(403).json({ error: "Origin is not allowed." });
      return;
    }
    next();
  });

  const rateBuckets = new Map();
  let concurrentRequests = 0;

  const authenticate = options.authenticate ?? (() => true);
  const parseJson = express.json({
    limit: maxRequestBytes,
    strict: true,
    type: ["application/json", "application/*+json"],
  });

  async function requireAuth(request, response, next) {
    try {
      if (await authenticate(request)) {
        next();
        return;
      }
      response.set("cache-control", "no-store");
      response.status(401).type("text/plain").send("Unauthorized");
    } catch (error) {
      next(error);
    }
  }

  function enforceRateLimit(request, response, next) {
    const now = Date.now();
    const identity = request.socket?.remoteAddress ?? "unknown";
    let bucket = rateBuckets.get(identity);
    if (!bucket || now - bucket.startedAt >= 60_000) {
      bucket = { startedAt: now, count: 0 };
      rateBuckets.set(identity, bucket);
    }
    if (rateBuckets.size > 1_024) {
      for (const [key, value] of rateBuckets) {
        if (now - value.startedAt >= 60_000) rateBuckets.delete(key);
      }
    }
    if (bucket.count >= requestsPerMinute) {
      response.set("retry-after", String(Math.max(1, Math.ceil((60_000 - (now - bucket.startedAt)) / 1_000))));
      response.status(429).json({ error: "MCP request rate limit exceeded." });
      return;
    }
    bucket.count += 1;
    next();
  }

  function enforceConcurrency(_request, response, next) {
    if (concurrentRequests >= maxConcurrentRequests) {
      response.set("retry-after", "1");
      response.status(503).json({ error: "Too many concurrent MCP requests." });
      return;
    }
    concurrentRequests += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      concurrentRequests = Math.max(0, concurrentRequests - 1);
    };
    response.once("finish", release);
    response.once("close", release);
    next();
  }

  app.post(
    route,
    requireAuth,
    enforceRateLimit,
    enforceConcurrency,
    (request, response, next) => {
      if (!request.is(["application/json", "application/*+json"])) {
        response.status(415).json({ error: "Content-Type must be application/json." });
        return;
      }
      parseJson(request, response, next);
    },
    async (request, response) => {
      const id = request.mcpRequestId;
      sanitizeRequest(request);
      const requestBody = rewriteToolAliases(request.body, options.toolAliases);

      // The Streamable HTTP spec requires both media types in Accept, but a
      // number of otherwise valid MCP clients send only application/json and
      // expect the non-streaming response form.  Enable that compatibility
      // mode only for connectors that explicitly opt in; all other services
      // retain the SDK's strict validation.
      const accept = headerValue(request, "accept").toLowerCase();
      const jsonOnlyCompatibility = allowJsonOnlyAccept
        && accept.includes("application/json")
        && !accept.includes("text/event-stream");
      if (jsonOnlyCompatibility) request.headers.accept = "application/json, text/event-stream";

      const server = options.createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: jsonOnlyCompatibility,
      });
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(new Error("MCP request deadline exceeded")), requestTimeoutMs);
      const abortRequest = () => controller.abort(new Error("MCP client disconnected"));
      request.once("aborted", abortRequest);
      response.on("close", () => {
        abortRequest();
        void transport.close();
        void server.close();
      });

      try {
        await runMcpRequestContext({ requestId: id, signal: controller.signal }, async () => {
          await server.connect(transport);
          await transport.handleRequest(request, response, requestBody);
        });
      } catch (error) {
        console.error(`[${serviceName}] MCP request ${id} failed:`, safeErrorMessage(error));
        if (!response.headersSent && !response.destroyed) {
          response.status(controller.signal.aborted ? 504 : 500).type("text/plain").send(
            controller.signal.aborted ? "MCP request deadline exceeded" : `${serviceName} MCP request failed`,
          );
        }
      } finally {
        clearTimeout(deadline);
        request.removeListener("aborted", abortRequest);
      }
    },
  );

  app.all(route, requireAuth, (_request, response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: `Method not allowed; use POST ${route}.` },
      id: null,
    });
  });

  return {
    app,
    errorHandler: errorHandler(serviceName),
    notFoundHandler,
    listen(port, callback) {
      const listener = app.listen(port, host, callback);
      listener.headersTimeout = 10_000;
      listener.requestTimeout = requestTimeoutMs;
      listener.keepAliveTimeout = 5_000;
      listener.maxRequestsPerSocket = 100;
      return listener;
    },
  };
}
