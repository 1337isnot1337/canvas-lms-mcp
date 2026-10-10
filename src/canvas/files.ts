import JSZip from "jszip";
import type { RuntimeConfig } from "../config";
import {
  arrayBufferToBase64,
  canvasFetchHeaders,
  canvasRequest,
  readArrayBufferCapped,
} from "./http";
import { canvasRelayDownload } from "./relay";
import { mcpReadMetadata } from "@canvas-lms-mcp/mcp-core";

export type CanvasFile = {
  id: number;
  display_name?: string;
  filename?: string;
  "content-type"?: string;
  url?: string;
  size?: number;
  created_at?: string;
  updated_at?: string;
  locked?: boolean;
  hidden?: boolean;
  locked_for_user?: boolean;
  hidden_for_user?: boolean;
  lock_explanation?: string;
  provider_url?: string | null;
  read_metadata?: ReturnType<typeof mcpReadMetadata>;
};

export async function getCanvasFileMetadata(
  config: RuntimeConfig,
  fileId: string | number,
): Promise<CanvasFile> {
  const response = await canvasRequest(config, {
    method: "GET",
    path: `/files/${encodeURIComponent(String(fileId))}`,
  });

  if (!response.ok) {
    throw new Error(`Canvas file metadata request failed with ${response.status}.`);
  }

  const data = response.data as CanvasFile;
  return {
    ...data,
    provider_url: data.url ?? null,
    read_metadata: mcpReadMetadata({
      source: response.source ?? "live",
      fetchedAt: response.fetched_at ?? new Date().toISOString(),
      totalCount: 1,
    }),
  };
}

export async function getCanvasFileRaw(
  config: RuntimeConfig,
  fileId: string | number,
): Promise<{
  ok: true;
  file_id: number;
  filename: string;
  mime_type: string;
  size: number | null;
  base64: string;
  provider_url: string | null;
  read_metadata: ReturnType<typeof mcpReadMetadata>;
}> {
  const meta = await getCanvasFileMetadata(config, fileId);
  const downloaded = await downloadCanvasFile(config, meta);

  return {
    ok: true,
    file_id: meta.id,
    filename: fileName(meta, downloaded.filename),
    mime_type: mimeType(meta, downloaded.mimeType),
    size: meta.size ?? downloaded.size,
    base64: arrayBufferToBase64(downloaded.bytes),
    provider_url: meta.url ?? null,
    read_metadata: meta.read_metadata ?? mcpReadMetadata({ source: "live", fetchedAt: new Date().toISOString(), totalCount: 1 }),
  };
}

export async function getCanvasFileContent(
  config: RuntimeConfig,
  fileId: string | number,
): Promise<{
  ok: true;
  file_id: number;
  filename: string;
  mime_type: string;
  size: number | null;
  provider_url: string | null;
  read_metadata: ReturnType<typeof mcpReadMetadata>;
  bytes: Uint8Array;
}> {
  const meta = await getCanvasFileMetadata(config, fileId);
  const downloaded = await downloadCanvasFile(config, meta);

  return {
    ok: true,
    file_id: meta.id,
    filename: fileName(meta, downloaded.filename),
    mime_type: mimeType(meta, downloaded.mimeType),
    size: meta.size ?? downloaded.size,
    provider_url: meta.url ?? null,
    read_metadata: meta.read_metadata ?? mcpReadMetadata({ source: "live", fetchedAt: new Date().toISOString(), totalCount: 1 }),
    bytes: downloaded.bytes,
  };
}

export async function getCanvasFileText(
  config: RuntimeConfig,
  fileId: string | number,
): Promise<{
  ok: true;
  file_id: number;
  filename: string;
  mime_type: string;
  size: number | null;
  text: string;
  truncated: boolean;
  provider_url: string | null;
  read_metadata: ReturnType<typeof mcpReadMetadata>;
}> {
  const meta = await getCanvasFileMetadata(config, fileId);
  const downloaded = await downloadCanvasFile(config, meta);
  const filename = fileName(meta, downloaded.filename);
  const type = mimeType(meta, downloaded.mimeType);
  const text = await extractTextFromBytes(downloaded.bytes, type, filename);
  const truncated = text.length > config.maxTextChars;

  return {
    ok: true,
    file_id: meta.id,
    filename,
    mime_type: type,
    size: meta.size ?? downloaded.size,
    text: truncated ? text.slice(0, config.maxTextChars) : text,
    truncated,
    provider_url: meta.url ?? null,
    read_metadata: meta.read_metadata ?? mcpReadMetadata({ source: "live", fetchedAt: new Date().toISOString(), totalCount: 1 }),
  };
}

async function downloadCanvasFile(
  config: RuntimeConfig,
  meta: CanvasFile,
): Promise<{ bytes: Uint8Array; mimeType: string; filename: string; size: number | null }> {
  if (!meta.url) {
    throw new Error("Canvas file metadata did not include a download URL.");
  }

  const downloadUrl = new URL(meta.url);
  if (downloadUrl.origin !== config.canvasOrigin) {
    throw new Error(`Refusing to download Canvas file from non-Canvas origin: ${downloadUrl.origin}`);
  }

  const response = config.canvasRelay
    ? await canvasRelayDownload(config, downloadUrl)
    : await fetch(downloadUrl, {
        headers: canvasFetchHeaders(config),
        redirect: "follow",
      });

  if (!response.ok) {
    throw new Error(`Canvas file download failed with ${response.status}.`);
  }

  return {
    bytes: await readArrayBufferCapped(response, config.maxFileBytes),
    mimeType: response.headers.get("content-type") || "application/octet-stream",
    filename: getFilenameFromHeaders(response.headers) || "file",
    size: numberOrNull(response.headers.get("content-length")),
  };
}

export async function extractTextFromBytes(
  bytes: ArrayBuffer | Uint8Array,
  mimeType: string,
  filename: string,
): Promise<string> {
  const lowerName = filename.toLowerCase();
  const lowerMime = mimeType.toLowerCase();

  const isDocx =
    lowerName.endsWith(".docx") ||
    lowerMime.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const isPlainText = lowerName.endsWith(".txt") || lowerMime.startsWith("text/plain");
  const isHtml =
    lowerName.endsWith(".html") ||
    lowerName.endsWith(".htm") ||
    lowerMime.startsWith("text/html");

  if (isDocx) return extractDocxText(toArrayBuffer(bytes));
  if (isPlainText || isHtml) {
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return isHtml ? stripHtml(raw) : raw;
  }

  throw new Error(
    `Unsupported file type for text extraction: ${mimeType || filename}. This server supports DOCX, TXT, and HTML.`,
  );
}

function toArrayBuffer(input: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (input instanceof ArrayBuffer) return input;
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return copy.buffer as ArrayBuffer;
}

async function extractDocxText(bytes: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const candidatePaths = Object.keys(zip.files)
    .filter((p) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(p))
    .sort((a, b) => docxPathScore(a) - docxPathScore(b) || a.localeCompare(b));

  if (candidatePaths.length === 0) {
    throw new Error("Could not find DOCX text XML files.");
  }

  const parts: string[] = [];
  for (const path of candidatePaths) {
    const file = zip.file(path);
    if (!file) continue;
    const xml = await file.async("string");
    const text = xmlToReadableText(xml);
    if (text.trim()) parts.push(text.trim());
  }

  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function docxPathScore(path: string): number {
  if (path.includes("document.xml")) return 0;
  if (path.includes("header")) return 1;
  if (path.includes("footer")) return 2;
  return 3;
}

function xmlToReadableText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/gi, "\t")
      .replace(/<w:br\b[^>]*\/>/gi, "\n")
      .replace(/<w:cr\b[^>]*\/>/gi, "\n")
      .replace(/<\/w:p>/gi, "\n")
      .replace(/<\/w:tr>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function stripHtml(html: string): string {
  return decodeXmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<\/(p|div|li|tr|h1|h2|h3|h4|h5|h6)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#160;/g, " ")
    .replace(/&#xA0;/gi, " ");
}

function fileName(meta: CanvasFile, downloadedName: string): string {
  return meta.display_name || meta.filename || downloadedName || `file-${meta.id}`;
}

function mimeType(meta: CanvasFile, downloadedType: string): string {
  return meta["content-type"] || downloadedType || "application/octet-stream";
}

function getFilenameFromHeaders(headers: Headers): string | null {
  const cd = headers.get("content-disposition");
  if (!cd) return null;

  const utf8Match = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1]);

  const plainMatch = cd.match(/filename="?([^"]+)"?/i);
  return plainMatch?.[1] ?? null;
}

function numberOrNull(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
