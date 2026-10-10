import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";

// Scan the publishable tree, including untracked files that are not ignored.
const files = [...new Set(execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" }).split("\0").filter(Boolean))];
const problems = [];
for (const file of files) {
  if (/(^|\/)(?:\.env(?:\..+)?|\.dev\.vars(?:\..+)?|\.secrets|secrets|\.codex|\.agents|\.wrangler)(\/|$)/.test(file)
      && !file.endsWith(".env.example")) {
    problems.push(`${file}: private configuration or state file`);
    continue;
  }
  if (/\.(?:log|pem|key|sqlite|db|zip|png|jpe?g|pdf|docx)$/i.test(file)) {
    problems.push(`${file}: data, binary, or key file requires manual review`);
    continue;
  }
  if (lstatSync(file).isSymbolicLink()) {
    problems.push(`${file}: symlink requires manual review`);
    continue;
  }
  const text = readFileSync(file, "utf8");
  if (text.includes("\0")) problems.push(`${file}: binary content requires manual review`);
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (/\/(?:home|Users)\/[A-Za-z0-9._-]+\//.test(line)) {
      problems.push(`${file}:${index + 1}: machine-specific home path`);
    }
    const emails = line.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
    if (emails.some((email) => !/@(?:[A-Z0-9-]+\.)*example\.(?:com|org|net|edu)$/i.test(email))) {
      problems.push(`${file}:${index + 1}: email address requires manual review`);
    }
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)) {
      problems.push(`${file}:${index + 1}: private key`);
    }
    const setting = /\b(?:CANVAS_TOKEN|MCP_URL_SECRET|CANVAS_RELAY_SECRET|RELAY_SHARED_SECRET)\s*([:=])\s*(?:"([^"]*)"|'([^']*)'|([^\s`,;]+))/.exec(line);
    const credential = setting?.[2] ?? setting?.[3] ?? setting?.[4];
    const literal = setting && (setting[1] === "=" || setting[2] !== undefined || setting[3] !== undefined);
    const synthetic = /(^|\/)test\//.test(file) && (credential?.startsWith("test-") || credential?.trim() === "" || credential === "short");
    if (literal && credential && !synthetic && !/^(?:<|\$|env\.|process\.|config\.|undefined|null)/.test(credential)) {
      problems.push(`${file}:${index + 1}: literal credential setting`);
    }
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Privacy guard passed for ${files.length} publishable files. Manual review and a secret scan are also required.`);
}
