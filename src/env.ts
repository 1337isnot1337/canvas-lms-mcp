import { readFileSync } from "node:fs";

export function environmentWithSecretFiles(keys: string[]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of keys) {
    const path = env[`${key}_FILE`]?.trim();
    if (path) env[key] = readFileSync(path, "utf8").trim();
  }
  return env;
}
