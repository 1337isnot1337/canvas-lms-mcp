import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { environmentWithSecretFiles } from "../src/env";

afterEach(() => vi.unstubAllEnvs());

it("reads mounted secret files, including relay credentials, without changing process.env", () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-secret-test-"));
  try {
    const file = join(dir, "secret");
    writeFileSync(file, " test-relay-secret-from-file\n");
    vi.stubEnv("CANVAS_RELAY_SECRET", "test-relay-secret-from-env");
    vi.stubEnv("CANVAS_RELAY_SECRET_FILE", file);
    expect(environmentWithSecretFiles(["CANVAS_RELAY_SECRET"]).CANVAS_RELAY_SECRET).toBe("test-relay-secret-from-file");
    expect(process.env.CANVAS_RELAY_SECRET).toBe("test-relay-secret-from-env");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
