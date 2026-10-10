export type RuntimeConfig = {
  mcpUrlSecret: string;
  canvasBaseUrl: string;
  canvasOrigin: string;
  canvasToken: string;
  canvasRelay?: {
    url: string;
    secret: string;
  };
  canvasUserAgent: string;
  canvasAccept: string;
  canvasAcceptLanguage: string;
  readOnly: boolean;
  maxApiResponseBytes: number;
  maxFileBytes: number;
  maxTextChars: number;
};

export type CanvasEnv = {
  MCP_URL_SECRET: string;
  CANVAS_BASE_URL: string;
  CANVAS_TOKEN?: string;
  CANVAS_RELAY_URL?: string;
  CANVAS_USER_AGENT?: string;
  CANVAS_ACCEPT?: string;
  CANVAS_ACCEPT_LANGUAGE?: string;
  READ_ONLY?: string;
  MAX_API_RESPONSE_BYTES?: string;
  MAX_FILE_BYTES?: string;
  MAX_TEXT_CHARS?: string;
};

type RelaySecretEnv = {
  CANVAS_RELAY_SECRET?: string;
  CANVAS_TOKEN?: string;
};

const DEFAULT_CANVAS_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 CanvasMCP/0.1.0";
const DEFAULT_CANVAS_ACCEPT = "application/json, text/plain, */*";
const DEFAULT_CANVAS_ACCEPT_LANGUAGE = "en-US,en;q=0.9";

function boolFromEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("Boolean settings must use true or false.");
}

function intFromEnv(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Byte and text limits must be positive integers.");
  }
  return parsed;
}

export function normalizeCanvasBaseUrl(input: string): string {
  const raw = (input ?? "").trim().replace(/\/+$/, "");
  if (!raw) throw new Error("CANVAS_BASE_URL must be set.");

  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") {
    throw new Error("CANVAS_BASE_URL must use https://");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      !["/", "/api/v1"].includes(parsed.pathname)) {
    throw new Error("CANVAS_BASE_URL must be an HTTPS origin, optionally ending in /api/v1, without credentials, query, or fragment.");
  }
  if (parsed.pathname === "/api/v1") parsed.pathname = "/";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");

  return parsed.toString().replace(/\/+$/, "");
}

function normalizeRelayUrl(input: string): string {
  const raw = input.trim().replace(/\/+$/, "");
  if (!raw) throw new Error("CANVAS_RELAY_URL must be set when CANVAS_RELAY_SECRET is set.");

  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") {
    throw new Error("CANVAS_RELAY_URL must use https://");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("CANVAS_RELAY_URL must be an HTTPS origin without a path, query, or credentials.");
  }

  return parsed.origin;
}

export function getConfig(env: CanvasEnv & RelaySecretEnv): RuntimeConfig {
  const mcpUrlSecret = env.MCP_URL_SECRET?.trim() ?? "";
  if (mcpUrlSecret.length < 24) {
    throw new Error("MCP_URL_SECRET must be set and at least 24 characters long.");
  }

  const canvasBaseUrl = normalizeCanvasBaseUrl(env.CANVAS_BASE_URL);
  const canvasOrigin = new URL(canvasBaseUrl).origin;
  const canvasToken = env.CANVAS_TOKEN?.trim() ?? "";
  const relayUrlInput = env.CANVAS_RELAY_URL?.trim() ?? "";
  const relaySecret = env.CANVAS_RELAY_SECRET?.trim() ?? "";

  if (Boolean(relayUrlInput) !== Boolean(relaySecret)) {
    throw new Error("CANVAS_RELAY_URL and CANVAS_RELAY_SECRET must be set together.");
  }

  const canvasRelay = relayUrlInput
    ? {
        url: normalizeRelayUrl(relayUrlInput),
        secret: relaySecret,
      }
    : undefined;

  if (canvasRelay && canvasRelay.secret.length < 32) {
    throw new Error("CANVAS_RELAY_SECRET must be at least 32 characters long.");
  }
  if (!canvasRelay && canvasToken.length < 10) {
    throw new Error("CANVAS_TOKEN must be set when CANVAS_RELAY_URL is not configured.");
  }

  const config: RuntimeConfig = {
    mcpUrlSecret,
    canvasBaseUrl,
    canvasOrigin,
    canvasToken,
    canvasUserAgent: env.CANVAS_USER_AGENT?.trim() || DEFAULT_CANVAS_USER_AGENT,
    canvasAccept: env.CANVAS_ACCEPT?.trim() || DEFAULT_CANVAS_ACCEPT,
    canvasAcceptLanguage: env.CANVAS_ACCEPT_LANGUAGE?.trim() || DEFAULT_CANVAS_ACCEPT_LANGUAGE,
    readOnly: boolFromEnv(env.READ_ONLY, true),
    maxApiResponseBytes: intFromEnv(env.MAX_API_RESPONSE_BYTES, 2_000_000),
    maxFileBytes: intFromEnv(env.MAX_FILE_BYTES, 10_000_000),
    maxTextChars: intFromEnv(env.MAX_TEXT_CHARS, 200_000),
  };

  if (canvasRelay) config.canvasRelay = canvasRelay;
  return config;
}
