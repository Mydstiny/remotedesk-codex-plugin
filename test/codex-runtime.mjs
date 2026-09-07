// Real pinned native engine and sandbox; fixed loopback responses, no account.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  access,
  readFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CodexAdapter } from "../src/codex-adapter.mjs";
import { Store } from "../packages/bridge-core/lib/store.mjs";
import { fixtureProvider } from "./local-provider.mjs";
const root = await realpath(
  await mkdtemp(join(tmpdir(), "remotedesk-codex-native-")),
);
const project = join(root, "project"),
  ownHome = join(root, "home"),
  codexHome = join(root, "codex");
for (const p of [project, ownHome, codexHome]) await mkdir(p);
const store = new Store(join(root, "state")),
  events = [],
  asks = [];
let next,
  decision = "decline",
  adapter;
const provider = await fixtureProvider(async () => {
  const action = next;
  next = action?.next;
  return action ?? { text: "NATIVE_FIXTURE_OK" };
});
const env = {
  ...process.env,
  HOME: ownHome,
  USERPROFILE: ownHome,
  CODEX_HOME: codexHome,
  TMPDIR: root,
};
const options = {
  env,
  providerOverrides: {
    ...provider.overrides,
    shell_environment_policy: {
      inherit: "none",
      set: {
        PATH: process.env.PATH,
        HOME: ownHome,
        USERPROFILE: ownHome,
        TMPDIR: root,
        ...(process.platform === "win32"
          ? { SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root }
          : {}),
      },
    },
  },
  diagnostic: (e) => console.error(JSON.stringify({ fixtureRequestError: e })),
};
const binding = {
  storage: store,
  projects: [{ id: "p", path: project }],
  emit: (id, event) => events.push({ ...event, sessionId: id }),
  ask: async (id, request) => {
    asks.push(request);
    const answer =
      request.kind === "questions"
        ? {
            answers: Object.fromEntries(
              request.questions.map((q) => [
                q.id,
                { answers: ["Native answer"] },
              ]),
            ),
          }
        : { decision };
    adapter.validateAnswer(request, answer);
    return answer;
  },
};
const make = () => {
  const a = new CodexAdapter(options);
  a.bind(binding);
  return a;
};
const waitFor = async (fn, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error("NATIVE_FIXTURE_TIMEOUT");
};
const s = {
  id: randomUUID(),
  project: "p",
  title: "Native test",
  permissionMode: "read-only",
};
const turn = async (action, answer = "decline") => {
  next = action;
  decision = answer;
  const started = await adapter.start(s, "Run this local test.");
  const finished = await waitFor(() =>
    events.find(
      (e) => e.type === "turn/completed" && e.params.turn.id === started.turnId,
    ),
  );
  await waitFor(() => !adapter.runs.has(s.id));
  return finished.params.turn;
};
const command = (cmd) => ({
  call: {
    name: "exec_command",
    arguments: {
      cmd,
      workdir: project,
      yield_time_ms: 1000,
      max_output_tokens: 1000,
      sandbox_permissions: "require_escalated",
      justification: "Run a fixed test only in this temporary project.",
    },
  },
});
const patch = (file) => ({
  custom: {
    name: "apply_patch",
    input: `*** Begin Patch\n*** Add File: ${file}\n+NATIVE_PATCH_OK\n*** End Patch`,
  },
});
try {
  adapter = make();
  await adapter.prepare();
  await adapter.create(s);
  const upstream = s.upstream;
  assert.equal(provider.calls.length, 0);
  assert.deepEqual((await adapter.read(s)).turns, []);
  await adapter.deactivate(s);
  await adapter.resume(s);
  assert.equal(s.upstream, upstream);
  await adapter.close();
  adapter = make();
  await adapter.prepare();
  await adapter.resume(s);
  assert.equal(s.upstream, upstream);
  assert.deepEqual((await adapter.read(s)).turns, []);
  assert.equal(provider.calls.length, 0);
  console.log(
    "PASS empty native thread read and cold resume without inference",
  );
  const models = await adapter.models(binding.projects[0]);
  assert.ok(Array.isArray(models.data));
  await turn(
    command("node -e \"require('fs').writeFileSync('denied.txt','bad')\""),
  );
  await assert.rejects(access(join(project, "denied.txt")));
  assert.equal(asks.at(-1).kind, "command");
  const accepted = command(
    "node -e \"require('fs').appendFileSync('accepted.txt','ok')\"",
  );
  const before = asks.length;
  await turn({ ...accepted, next: accepted }, "accept");
  assert.equal(asks.length - before, 2);
  assert.equal(await readFile(join(project, "accepted.txt"), "utf8"), "okok");
  await turn(patch("denied-patch.txt"));
  await assert.rejects(access(join(project, "denied-patch.txt")));
  assert.equal(asks.at(-1).kind, "fileChange");
  await turn(patch("accepted-patch.txt"), "accept");
  assert.equal(
    await readFile(join(project, "accepted-patch.txt"), "utf8"),
    "NATIVE_PATCH_OK\n",
  );
  await turn({
    call: {
      name: "request_user_input",
      arguments: {
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Fixture?",
            options: [
              { label: "Yes", description: "Continue" },
              { label: "No", description: "Stop" },
            ],
          },
        ],
      },
    },
  });
  assert.equal(asks.at(-1).kind, "questions");
  assert.ok(
    JSON.stringify(provider.calls).includes("Native answer"),
    "structured answer must reach the native provider",
  );
  const tools = JSON.stringify(provider.calls[0].tools);
  for (const name of [
    "exec_command",
    "write_stdin",
    "apply_patch",
    "request_user_input",
  ])
    assert.ok(tools.includes(name));
  assert.ok(!tools.includes("remotedesk_workspace_"));
  console.log(
    "PASS native command and patch accept/decline, once approvals and structured questions",
  );
  await turn(
    command(
      "node -e \"console.log('NATIVE_BACKGROUND');setTimeout(()=>{},20000)\"",
    ),
    "accept",
  );
  const terminals = await adapter.terminals(s);
  assert.ok(terminals.data.length);
  await assert.rejects(adapter.quiescent(s), /BACKGROUND_TERMINALS_ACTIVE/);
  for (const row of terminals.data)
    assert.equal(
      (await adapter.stopTerminal(s, row.processId)).terminated,
      true,
    );
  await adapter.quiescent(s);
  const cancelled = await turn(
    command("node -e \"require('fs').writeFileSync('cancelled.txt','bad')\""),
    "cancel",
  );
  assert.equal(cancelled.status, "interrupted");
  await assert.rejects(access(join(project, "cancelled.txt")));
  await adapter.update(s, { title: "Renamed", reasoningEffort: "medium" });
  assert.equal(s.reasoningEffort, "medium");
  const child = { ...s, id: randomUUID(), title: "Forked" };
  delete child.upstream;
  await adapter.fork(s, child);
  assert.notEqual(child.upstream, s.upstream);
  assert.ok((await adapter.read(child)).turns.length);
  await adapter.deactivate(child);
  await adapter.close();
  adapter = make();
  await adapter.prepare();
  await adapter.resume(s);
  assert.equal(s.upstream, upstream);
  assert.equal(s.reasoningEffort, "medium");
  next = { hang: true };
  await adapter.start(s, "Cancel provider wait.");
  await waitFor(() => adapter.runs.get(s.id)?.turnId);
  await adapter.cancel(s);
  await adapter.quiescent(s);
  await adapter.archive(s);
  assert.equal(s.nativeArchived, true);
  assert.equal(adapter.rpcs.has(s.id), false);
  assert.ok((await adapter.read(s)).turns.length);
  assert.equal(adapter.rpcs.has(s.id), false);
  await adapter.resume(s);
  assert.equal(s.nativeArchived, false);
  assert.equal(s.upstream, upstream);
  assert.equal(store.all("nativeActivity").length, 0);
  console.log(
    "PASS native background retention/stop, cancel, models/effort, rename, fork, archive/read/unarchive and cold history",
  );
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await adapter?.close();
  await provider.close();
  store.close();
  await rm(root, { recursive: true, force: true });
}
