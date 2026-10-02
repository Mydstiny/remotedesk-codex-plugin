import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, addProject } from "../packages/bridge-core/lib/admin.mjs";
import { Store } from "../packages/bridge-core/lib/store.mjs";
import { startControlPanel } from "../src/control-panel.mjs";

test("control panel stays loopback, authenticates API calls, and manages state", async () => {
  const root = await mkdtemp(join(tmpdir(), "remotedesk-codex-panel-"));
  const state = join(root, "state");
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  try {
    await init(state, { engine: "codex", port: 9443 });
    await addProject(state, { id: "demo", path: projectPath, title: "Demo" });
    const panel = await startControlPanel(state, { engine: "codex", port: 0 });
    try {
      assert.equal(panel.server.address().address, "127.0.0.1");
      const unauthorized = await fetch("http://127.0.0.1:" + panel.port + "/api/status");
      assert.equal(unauthorized.status, 401);
      const page = await fetch(panel.url);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /控制面板/);
      assert.match(html, /prefers-color-scheme:dark/);
      assert.match(html, /--panel-surface/);
      assert.match(html, /background:var\(--panel-surface\)/);
      const headers = { Authorization: "Bearer " + panel.token };
      const wrongToken = await fetch("http://127.0.0.1:" + panel.port + "/api/status", { headers: { Authorization: "Bearer wrong" } });
      assert.equal(wrongToken.status, 401);
      const queryToken = await fetch("http://127.0.0.1:" + panel.port + "/api/status?token=" + encodeURIComponent(panel.token));
      assert.equal(queryToken.status, 401);
      const crossOrigin = await fetch("http://127.0.0.1:" + panel.port + "/api/status", { headers: { ...headers, Origin: "https://example.invalid" } });
      assert.equal(crossOrigin.status, 401);
      const response = await fetch("http://127.0.0.1:" + panel.port + "/api/status", { headers });
      assert.equal(response.status, 200);
      const snapshot = await response.json();
      assert.equal(snapshot.engine, "codex");
      assert.equal(snapshot.projects[0].id, "demo");
      const invalidProject = await fetch("http://127.0.0.1:" + panel.port + "/api/project", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ id: "bad", path: "/path/that/does/not/exist" }),
      });
      assert.equal(invalidProject.status, 400);
      assert.equal((await invalidProject.text()).includes("/path/that/does"), false);
      const inviteResponse = await fetch("http://127.0.0.1:" + panel.port + "/api/invite", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ projects: ["demo"], role: "viewer" }),
      });
      assert.equal(inviteResponse.status, 200);
      const invitePayload = await inviteResponse.json();
      const invite = invitePayload.invite;
      assert.equal(typeof invite.code, "string");
      assert.equal(invite.code.length > 20, true);
      assert.match(invitePayload.qr, /^data:image\/svg\+xml;base64,/);
      assert.match(invitePayload.pairingLink, /^remotedesk:\/\/pair\?data=/);
      const store = new Store(state);
      store.put("device", "device-1", {
        id: "device-1",
        name: "Test device",
        projects: ["demo"],
        role: "viewer",
        revoked: false,
        generation: 0,
        expires: Date.now() + 60_000,
      });
      store.close();
      const revokeResponse = await fetch("http://127.0.0.1:" + panel.port + "/api/revoke", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ device: "device-1" }),
      });
      assert.equal(revokeResponse.status, 200);
      assert.deepEqual((await revokeResponse.json()).result, { revoked: "device-1" });
    } finally {
      await panel.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
