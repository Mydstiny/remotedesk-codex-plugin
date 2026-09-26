import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { doctor } from "../src/doctor.mjs";
import {
  nodeVersionSupported,
  parseCodexVersion,
} from "../src/compatibility-policy.mjs";

test("compatibility policy enforces the Node engine floor and strict version output", () => {
  assert.equal(nodeVersionSupported("22.15.0"), false);
  assert.equal(nodeVersionSupported("22.16.0"), true);
  assert.equal(nodeVersionSupported("26.4.0"), true);
  assert.equal(parseCodexVersion("codex 0.156.1\nunexpected"), null);
  assert.equal(parseCodexVersion("codex 0.156.1\n"), "0.156.1");
});

async function versionFixture(version) {
  const root = await mkdtemp(join(tmpdir(), "remotedesk-codex-version-"));
  const file = join(root, "codex-version.js");
  await writeFile(file, `console.log(\"codex ${version}\");\n`);
  await chmod(file, 0o755);
  return { file, root };
}

test("current pinned Codex 0.156.1 passes the compatibility gate", async () => {
  const fixture = await versionFixture("0.156.1");
  try {
    const report = await doctor({ command: fixture.file });
    assert.equal(report.status, "ok");
    assert.equal(report.componentVersions.codex, "0.156.1");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unknown engine version prevents a probe", async () => {
  const report = await doctor({ command: process.execPath, probe: true });
  assert.equal(report.status, "blocked");
  assert.equal(report.checks.at(-1).code, "CODEX_VERSION_UNVERIFIED");
  assert.equal(report.capabilities.remoteAccess, false);
});
test("missing executable returns sanitized diagnostic without a path", async () => {
  const report = await doctor({ command: "/nonexistent/SECRET_SENTINEL" });
  assert.equal(report.status, "blocked");
  assert.ok(!JSON.stringify(report).includes("SECRET_SENTINEL"));
});
test("an aborted probe starts no engine", async () => {
  const controller = new AbortController();
  controller.abort();
  const report = await doctor({
    command: "/nonexistent/SHOULD_NOT_START",
    signal: controller.signal,
    probe: true,
  });
  assert.equal(report.checks.at(-1).code, "PROBE_CANCELLED");
});
