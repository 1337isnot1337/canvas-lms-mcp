import type { RuntimeConfig } from "../config";
import { mcpReadMetadata } from "@canvas-lms-mcp/mcp-core";
import {
  buildCanvasApiUrl,
  canvasRequestUrl,
  type CanvasResponse,
  type QueryParams,
} from "./http";

export type PaginateOptions = {
  path: string;
  query?: QueryParams;
  maxPages?: number;
  perPage?: number;
};

export type PaginatedCanvasResponse = {
  ok: boolean;
  pages_fetched: number;
  items: unknown[];
  pages?: unknown[];
  source: "live" | "cache" | "derived" | "unknown";
  fetched_at: string | null;
  read_at: string;
  age_seconds: number | null;
  freshness: "fresh" | "stale" | "unknown";
  pagination: ReturnType<typeof mcpReadMetadata>["pagination"];
  last_response: Pick<CanvasResponse, "status" | "statusText" | "url" | "link">;
};

export function getNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;

  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === "next") return match[1] ?? null;
  }

  return null;
}

export async function canvasPaginate(
  config: RuntimeConfig,
  options: PaginateOptions,
): Promise<PaginatedCanvasResponse> {
  const maxPages = Math.min(Math.max(options.maxPages ?? 10, 1), 50);
  const query = { ...(options.query ?? {}) };
  if (query.per_page === undefined && options.perPage === undefined) query.per_page = 100;
  if (options.perPage !== undefined) query.per_page = options.perPage;

  let nextUrl: URL | null = buildCanvasApiUrl(config, options.path, query);
  let pagesFetched = 0;
  const items: unknown[] = [];
  const pages: unknown[] = [];
  let lastResponse: CanvasResponse | null = null;
  const fetchedAt = new Date().toISOString();

  while (nextUrl && pagesFetched < maxPages) {
    const response = await canvasRequestUrl(config, nextUrl, { method: "GET" });
    pagesFetched += 1;
    lastResponse = response;

    if (Array.isArray(response.data)) {
      items.push(...response.data);
    } else {
      pages.push(response.data);
    }

    if (!response.ok) break;
    const next = getNextLink(response.link);
    nextUrl = next ? new URL(next) : null;
  }

  if (!lastResponse) {
    throw new Error("Pagination failed before making a Canvas request.");
  }

  const result: PaginatedCanvasResponse = {
    ok: lastResponse.ok,
    pages_fetched: pagesFetched,
    items,
    ...mcpReadMetadata({
      source: "live",
      fetchedAt,
      hasMore: nextUrl !== null,
      nextCursor: nextUrl?.toString() ?? null,
      truncated: nextUrl !== null,
    }),
    last_response: {
      status: lastResponse.status,
      statusText: lastResponse.statusText,
      url: lastResponse.url,
      link: lastResponse.link,
    },
  };

  if (pages.length > 0) result.pages = pages;
  return result;
}
