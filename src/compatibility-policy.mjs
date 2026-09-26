import { readFile } from "node:fs/promises";

export const compatibility = JSON.parse(
  await readFile(new URL("../compatibility.json", import.meta.url)),
);

export function parseCodexVersion(stdout) {
  const match = /^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:-[\w.]+)?)$/.exec(
    String(stdout).trim(),
  );
  return match?.[1] ?? null;
}

export function nodeVersionSupported(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version));
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 16);
}
