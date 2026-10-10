import { describe, expect, it } from "vitest";
import { extractTextFromBytes } from "../src/canvas/files";

function bytes(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer;
}

describe("Canvas file text extraction", () => {
  it("extracts plain text", async () => {
    await expect(extractTextFromBytes(bytes("hello"), "text/plain", "note.txt")).resolves.toBe(
      "hello",
    );
  });

  it("strips HTML", async () => {
    await expect(
      extractTextFromBytes(
        bytes("<html><body><h1>Title</h1><script>bad()</script><p>Body</p></body></html>"),
        "text/html",
        "page.html",
      ),
    ).resolves.toBe("Title\nBody");
  });

  it("rejects unsupported file types", async () => {
    await expect(
      extractTextFromBytes(bytes("%PDF"), "application/pdf", "file.pdf"),
    ).rejects.toThrow(/Unsupported file type/);
  });
});
