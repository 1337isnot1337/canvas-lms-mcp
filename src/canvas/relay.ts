import type { RuntimeConfig } from "../config";
import type {
  CanvasHeaderProbeResult,
  CanvasMethod,
  CanvasResponse,
  ResponseMode,
} from "./http";

type RelayRequestOptions = {
  method: CanvasMethod;
  url: URL;
  body?: unknown;
  responseMode: ResponseMode;
};

function relayEndpoint(config: RuntimeConfig, path: string): URL {
  if (!config.canvasRelay) {
    throw new Error("Canvas relay is not configured.");
  }
  return new URL(path, config.canvasRelay.url);
}

async function relayError(response: Response): Promise<Error> {
  const preview = (await response.text()).replace(/\s+/g, " ").slice(0, 300);
  return new Error(
    `Canvas relay request failed with ${response.status}${preview ? `: ${preview}` : ""}`,
  );
}

async function relayJson<T>(
  config: RuntimeConfig,
  path: string,
  payload: unknown,
): Promise<T> {
  const response = await fetch(relayEndpoint(config, path), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.canvasRelay?.secret ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) throw await relayError(response);
  return (await response.json()) as T;
}

export async function canvasRelayRequest(
  config: RuntimeConfig,
  options: RelayRequestOptions,
): Promise<CanvasResponse> {
  return relayJson<CanvasResponse>(config, "/v1/canvas", {
    method: options.method,
    url: options.url.toString(),
    body: options.body,
    response_mode: options.responseMode,
  });
}

export async function canvasRelayProbe(
  config: RuntimeConfig,
  options: {
    url: URL;
    profile: CanvasHeaderProbeResult["profile"];
    includeAuthorization: boolean;
  },
): Promise<CanvasHeaderProbeResult> {
  return relayJson<CanvasHeaderProbeResult>(config, "/v1/probe", {
    url: options.url.toString(),
    profile: options.profile,
    include_authorization: options.includeAuthorization,
  });
}

export async function canvasRelayDownload(config: RuntimeConfig, url: URL): Promise<Response> {
  const response = await fetch(relayEndpoint(config, "/v1/download"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.canvasRelay?.secret ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: url.toString() }),
  });

  if (!response.ok) throw await relayError(response);
  return response;
}

export async function canvasRelayHealth(config: RuntimeConfig): Promise<boolean> {
  if (!config.canvasRelay) return false;

  const response = await fetch(relayEndpoint(config, "/v1/health"), {
    headers: { Authorization: `Bearer ${config.canvasRelay.secret}` },
  });
  return response.ok;
}
