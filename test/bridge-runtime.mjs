// Real Codex AppServer, native tools and mTLS; deterministic local model only.
import { pngBase64 } from "./fixture-image.mjs";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Bridge } from "../packages/bridge-core/lib/server.mjs";
import {
  init,
  addProject,
  invite,
  configuration,
  revoke,
} from "../packages/bridge-core/lib/admin.mjs";
import { pairClient, loadClient } from "../packages/bridge-core/lib/client.mjs";
import { CodexAdapter } from "../src/codex-adapter.mjs";
import { fixtureProvider } from "./local-provider.mjs";
const root = await realpath(
    await mkdtemp(join(tmpdir(), "remotedesk-codex-wire-")),
  ),
  workspace = join(root, "workspace"),
  state = join(root, "state");
await mkdir(workspace);
const ownHome = join(root, "home"),
  codexHome = join(root, "codex");
await mkdir(ownHome);
await mkdir(codexHome);
const env = {
  ...process.env,
  HOME: ownHome,
  USERPROFILE: ownHome,
  CODEX_HOME: codexHome,
  TMPDIR: root,
};
let mode = "text",
  bridge,
  releaseModel,
  steerSeen = false;
const provider = await fixtureProvider(async (request) => {
  steerSeen ||= JSON.stringify(request.input).includes("STEER_FIXTURE");
  const next = mode;
  if (next === "hold") {
    await new Promise((r) => (releaseModel = r));
    mode = "text";
    return { text: "FIRST_STEP_DONE" };
  }
  if (next === "hang") return { hang: true };
  mode = "text";
  if (next === "patch")
    return {
      custom: {
        name: "apply_patch",
        input:
          "*** Begin Patch\n*** Update File: edit-preview.txt\n*** Move to: moved-preview.txt\n@@\n-before\n+after\n*** Delete File: delete-preview.txt\n*** Add File: added-preview.txt\n+" +
          "p".repeat(210000) +
          "\n*** End Patch",
      },
    };
  if (next === "exec")
    return {
      call: {
        name: "exec_command",
        arguments: {
          cmd: "node -e \"require('fs').writeFileSync('codex-result.txt','CODEX_NATIVE_OK')\"",
          workdir: workspace,
          yield_time_ms: 1000,
          sandbox_permissions: "require_escalated",
          justification:
            "Write only a fixed fixture in this temporary test project.",
        },
      },
    };
  if (next === "question")
    return {
      call: {
        name: "request_user_input",
        arguments: {
          questions: [
            {
              id: "wire",
              header: "Fixture",
              question: "Fixture question?",
              options: [
                { label: "Yes", description: "Continue" },
                { label: "No", description: "Stop" },
              ],
            },
          ],
        },
      },
    };
  return { text: "CODEX_WIRE_COMPLETE" };
});
const waitFor = async (fn) => {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("FIXTURE_WAIT_TIMEOUT");
};
try {
  await init(state, { engine: "codex" });
  await addProject(state, {
    id: "p",
    path: workspace,
    vision: true,
  });
  const config = await configuration(state);
  config.port = 0;
  config.coordinationDirectory = join(root, "locks");
  await writeFile(join(state, "config.json"), JSON.stringify(config));
  bridge = new Bridge(
    state,
    new CodexAdapter({ env, providerOverrides: provider.overrides }),
  );
  let { address } = await bridge.start();
  const directory = join(root, "client");
  await pairClient(directory, {
    url: `https://127.0.0.1:${address.port}`,
    invite: await invite(state, { projects: ["p"] }),
  });
  const loaded = await loadClient(directory),
    client = loaded.client;
  let handshake = loaded.handshake;
  const call = (method, params, operationId = randomUUID()) =>
    client.write(method, params, { operationId, epoch: handshake.epoch.id });
  const created = await call("session.create", { projectId: "p" });
  assert.equal(created.status, "succeeded", JSON.stringify(created));
  const id = created.result.sessionId;
  let lease = (await call("lease.acquire", { sessionId: id })).result.lease;
  const events = [],
    abort = new AbortController();
  const stream = client
    .events({
      cursor: 0,
      runtime: handshake.runtime,
      signal: abort.signal,
      onEvent: (e) => events.push(e),
    })
    .catch((e) => e);
  const turn = async (next, answer) => {
    mode = next;
    const op = randomUUID(),
      params = { sessionId: id, lease, text: "Wire fixture " + next };
    const receipt = await call("turn.start", params, op);
    assert.equal(receipt.status, "succeeded", JSON.stringify(receipt));
    assert.deepEqual(await call("turn.start", params, op), receipt);
    if (answer) {
      const pending = await waitFor(
        async () => (await client.read("approval.list", { sessionId: id }))[0],
      );
      assert.equal(
        (
          await call("approval.answer", {
            sessionId: id,
            lease,
            approvalId: pending.id,
            answer,
          })
        ).status,
        "succeeded",
      );
    }
    await waitFor(() => !bridge.adapter.runs.has(id));
  };
  await turn("exec", { decision: "accept" });
  assert.equal(
    await readFile(join(workspace, "codex-result.txt"), "utf8"),
    "CODEX_NATIVE_OK",
  );
  await turn("exec", { decision: "decline" });
  await turn("question", {
    answers: { wire: { answers: ["CODEX_WIRE_ANSWER"] } },
  });
  assert.ok(JSON.stringify(provider.calls).includes("CODEX_WIRE_ANSWER"));
  await writeFile(join(workspace, "edit-preview.txt"), "before\n");
  await writeFile(join(workspace, "delete-preview.txt"), "remove\n");
  mode = "patch";
  await call("turn.start", {
    sessionId: id,
    lease,
    text: "Pending preview reconnect fixture",
  });
  const fileApproval = await waitFor(
    async () => (await client.read("approval.list", { sessionId: id }))[0],
  );
  assert.equal(fileApproval.request.nativeItemComplete, true);
  const changes = fileApproval.request.nativeItem.changes;
  assert.equal(changes.length, 3);
  assert.ok(
    changes.some(
      (c) =>
        c.path.endsWith("added-preview.txt") &&
        c.diff.includes("p".repeat(210000)),
    ),
  );
  assert.ok(
    changes.some(
      (c) =>
        c.path.endsWith("edit-preview.txt") &&
        JSON.stringify(c.kind).includes("moved-preview.txt"),
    ),
  );
  assert.ok(changes.some((c) => c.path.endsWith("delete-preview.txt")));
  // The real native engine omits the pending file item from history. A fresh
  // client must still recover it after the event window has moved past it.
  for (let i = 0; i < 2005; i++)
    bridge.emit(id, { type: "fixture.preview-window", i });
  const reconnected = (await loadClient(directory)).client;
  const whilePending = await reconnected.read("session.read", {
    sessionId: id,
  });
  const pendingTurn = whilePending.snapshot.turns.find(
    (t) => t.id === fileApproval.request.turnId,
  );
  assert.ok(!pendingTurn.items.some((item) => item.type === "fileChange"));
  const restoredApproval = (
    await reconnected.read("approval.list", { sessionId: id })
  )[0];
  assert.deepEqual(
    restoredApproval.request.nativeItem,
    fileApproval.request.nativeItem,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(restoredApproval)) > 200000);
  assert.equal(
    (
      await call("approval.answer", {
        sessionId: id,
        lease,
        approvalId: restoredApproval.id,
        answer: { decision: "decline" },
      })
    ).status,
    "succeeded",
  );
  await waitFor(() => !bridge.adapter.runs.has(id));
  assert.equal(bridge.adapter.fileChanges.size, 0);
  assert.equal(bridge.adapter.fileChangeBytes, 0);
  assert.equal(
    await readFile(join(workspace, "edit-preview.txt"), "utf8"),
    "before\n",
  );
  await assert.rejects(readFile(join(workspace, "added-preview.txt")), {
    code: "ENOENT",
  });
  mode = "patch";
  await call("turn.start", {
    sessionId: id,
    lease,
    text: "Cancel pending preview fixture",
  });
  await waitFor(
    async () => (await client.read("approval.list", { sessionId: id })).length,
  );
  assert.equal(
    (await call("turn.cancel", { sessionId: id, lease })).status,
    "succeeded",
  );
  assert.equal(bridge.adapter.fileChanges.size, 0);
  assert.equal(bridge.adapter.fileChangeBytes, 0);
  const remember = bridge.adapter.rememberFileChange;
  bridge.adapter.rememberFileChange = () => {};
  await turn("patch");
  bridge.adapter.rememberFileChange = remember;
  assert.equal(
    (await client.read("approval.list", { sessionId: id })).length,
    0,
  );
  await assert.rejects(readFile(join(workspace, "added-preview.txt")), {
    code: "ENOENT",
  });
  assert.ok(
    events.some(
      (e) => e.event?.reason === "NATIVE_FILE_CHANGE_PREVIEW_UNAVAILABLE",
    ),
  );
  console.log(
    "PASS complete pending patch preview after fresh mTLS client and event eviction; decline/cancel cleanup and missing-preview refusal",
  );
  const upload = await call("attachment.upload", {
    projectId: "p",
    mime: "text/plain",
    data: Buffer.from("TEXT_ATTACHMENT_OK").toString("base64"),
  });
  assert.equal(upload.status, "succeeded");
  mode = "text";
  assert.equal(
    (
      await call("turn.start", {
        sessionId: id,
        lease,
        text: "Attachment fixture",
        attachments: [upload.result.attachmentId],
      })
    ).status,
    "succeeded",
  );
  await waitFor(() => !bridge.adapter.runs.has(id));
  assert.ok(
    JSON.stringify(
      await client.read("session.read", { sessionId: id }),
    ).includes("TEXT_ATTACHMENT_OK"),
  );
  const imageUpload = await call("attachment.upload", {
    projectId: "p",
    mime: "image/png",
    data: pngBase64,
  });
  assert.equal(imageUpload.status, "succeeded");
  mode = "text";
  assert.equal(
    (
      await call("turn.start", {
        sessionId: id,
        lease,
        text: "Image fixture",
        attachments: [imageUpload.result.attachmentId],
      })
    ).status,
    "succeeded",
  );
  await waitFor(() => !bridge.adapter.runs.has(id));
  assert.ok(
    provider.calls.at(-1).images > 0,
    "image reaches actual App Server model request",
  );
  mode = "hold";
  await call("turn.start", { sessionId: id, lease, text: "Steering fixture" });
  await waitFor(() => releaseModel);
  assert.equal(
    (await call("turn.steer", { sessionId: id, lease, text: "STEER_FIXTURE" }))
      .status,
    "succeeded",
  );
  releaseModel();
  await waitFor(() => !bridge.adapter.runs.has(id));
  assert.ok(steerSeen, "steer reaches the next model step");
  assert.ok(
    JSON.stringify(
      await client.read("session.read", { sessionId: id }),
    ).includes("STEER_FIXTURE"),
  );
  mode = "hang";
  await call("turn.start", { sessionId: id, lease, text: "Cancel fixture" });
  await waitFor(() => bridge.adapter.runs.get(id)?.turnId);
  assert.equal(
    (await call("turn.cancel", { sessionId: id, lease })).status,
    "succeeded",
  );
  assert.equal(
    (await call("session.archive", { sessionId: id, lease })).status,
    "succeeded",
  );
  assert.equal(
    (await call("session.resume", { sessionId: id, lease })).status,
    "succeeded",
  );
  await turn("exec", { decision: "accept" });
  assert.ok(
    events.some((e) => JSON.stringify(e).includes("CODEX_WIRE_COMPLETE")),
  );
  abort.abort();
  await stream;
  // Restart the actual bridge at the same endpoint and reconcile through snapshots.
  config.port = address.port;
  await writeFile(join(state, "config.json"), JSON.stringify(config));
  await bridge.stop();
  bridge = new Bridge(
    state,
    new CodexAdapter({ env, providerOverrides: provider.overrides }),
  );
  await bridge.start();
  handshake = await client.read("handshake", { version: 1 });
  lease = (await call("lease.acquire", { sessionId: id })).result.lease;
  assert.equal(
    (await call("session.resume", { sessionId: id, lease })).status,
    "succeeded",
  );
  await turn("exec", { decision: "accept" });
  revoke(state, handshake.deviceId);
  await assert.rejects(client.read("project.list"), /DEVICE_UNAUTHORIZED/);
  console.log(
    "PASS Codex AppServer native tools + mTLS: approval, question, attachments, streams, dedup, cancel, archive, full process restart/resume and revoke",
  );
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await bridge?.stop();
  await provider.close();
  await rm(root, { recursive: true, force: true });
}
