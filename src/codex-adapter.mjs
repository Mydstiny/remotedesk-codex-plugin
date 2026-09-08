import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, realpath } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";
import { StdioRpc } from "../packages/bridge-core/stdio-rpc.mjs";
import { nativeEnvironment } from "../packages/bridge-core/lib/native-workspace.mjs";
import { validateNativeAnswer } from "../packages/bridge-core/lib/native-answers.mjs";
import {
  Fault,
  requireThat,
  fields,
  string,
} from "../packages/bridge-core/lib/errors.mjs";
const exec = promisify(execFile);
export const DISABLED_FEATURES = [
  "apps",
  "plugins",
  "hooks",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "in_app_browser",
  "in_app_local_automation",
  "multi_agent",
  "multi_agent_v2",
  "memories",
  "chronicle",
  "workspace_dependencies",
  "remote_plugin",
  "skill_mcp_dependency_install",
  "in_app_chat",
  "realtime_conversation",
];
export const APPROVAL_POLICY = "on-request";
export function remoteConfig(
  profile,
  mcpNames = [],
  inheritedEnvironment = [],
  mode = "read-only",
) {
  const environment = nativeEnvironment();
  for (const key of inheritedEnvironment)
    if (!(key in environment)) environment[key] = "";
  return {
    agents: { enabled: false },
    default_permissions: profile,
    permissions: {
      [profile]: {
        filesystem: {
          ":root": "read",
          ":tmpdir": mode === "read-only" ? "read" : "write",
          ":slash_tmp": mode === "read-only" ? "read" : "write",
          ":workspace_roots": {
            ".": mode === "read-only" ? "read" : "write",
            ".git": "read",
            ".codex": "read",
            ".agents": "read",
          },
        },
        network: { enabled: false },
      },
    },
    features: {
      ...Object.fromEntries(DISABLED_FEATURES.map((n) => [n, false])),
      default_mode_request_user_input: true,
    },
    tools: {
      experimental_request_user_input: { enabled: true },
      update_plan: { enabled: true },
    },
    notify: [],
    orchestrator: { mcp: { enabled: false }, skills: { enabled: false } },
    mcp_servers: Object.fromEntries(
      mcpNames.map((n) => [n, { enabled: false }]),
    ),
    allow_login_shell: false,
    shell_environment_policy: {
      inherit: "none",
      ignore_default_excludes: false,
      set: environment,
    },
    web_search: "disabled",
    approval_policy: APPROVAL_POLICY,
    approvals_reviewer: "user",
    ...(process.platform === "win32"
      ? { windows: { sandbox: "unelevated" } }
      : {}),
  };
}
export async function codexCommand(explicit) {
  if (explicit) {
    const p = await realpath(explicit);
    return p.endsWith(".js")
      ? { command: process.execPath, prefix: [p] }
      : { command: p, prefix: [] };
  }
  for (const p of (process.env.PATH ?? "").split(delimiter)) {
    try {
      if (process.platform === "win32") {
        const file = join(
          p,
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
        await access(file);
        return { command: process.execPath, prefix: [file] };
      }
      const file = await realpath(join(p, "codex"));
      return file.endsWith(".js")
        ? { command: process.execPath, prefix: [file] }
        : { command: file, prefix: [] };
    } catch {
      /* Continue PATH. */
    }
  }
  throw new Fault("CODEX_EXECUTABLE_NOT_FOUND");
}
const deadline = async (promise, ms, code) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Fault(code)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
export class CodexAdapter {
  capabilities = {
    sessions: true,
    turns: true,
    steer: true,
    cancel: true,
    approvals: true,
    questions: true,
    diffs: true,
    files: "native-tools",
    models: true,
    rename: true,
    fork: true,
    compact: true,
    terminalManagement: true,
    attachments: ["text/plain", "image/png", "image/jpeg"],
    execution: "codex-native-sandbox",
    permissionModes: ["read-only", "workspace-write"],
    collaborationModes: ["default", "plan"],
    approvalDecisions: ["accept", "decline", "cancel"],
    outsideSandboxApproval: true,
    extensions: false,
    delegation: false,
    processScope: "native-managed-terminals",
  };
  constructor({ command, providerOverrides, diagnostic, env } = {}) {
    this.explicit = command;
    this.providerOverrides = providerOverrides;
    this.diagnostic = diagnostic;
    this.env = env;
    this.rpcs = new Map();
    this.loading = new Map();
    this.runs = new Map();
    this.pending = new Map();
    this.fileChanges = new Map();
    this.fileChangeBytes = 0;
    this.sessions = new Map();
    this.closed = false;
    this.blocked = new Set();
  }
  bind(core) {
    this.core = core;
  }
  checkpoint(s, patch) {
    Object.assign(s, patch);
    this.core.checkpoint?.(s, patch);
  }
  fileChangeKey(s, turnId, itemId) {
    return JSON.stringify([s.id, turnId, itemId]);
  }
  dropFileChange(key) {
    const previous = this.fileChanges.get(key);
    if (previous) this.fileChangeBytes -= previous.bytes;
    this.fileChanges.delete(key);
  }
  clearFileChanges(s) {
    for (const [key, value] of this.fileChanges)
      if (value.session === s.id) this.dropFileChange(key);
  }
  rememberFileChange(s, params) {
    const key = this.fileChangeKey(s, params.turnId, params.item.id);
    this.dropFileChange(key);
    const encoded = JSON.stringify(params.item),
      bytes = Buffer.byteLength(encoded);
    // Pending native patches are absent from history reads. Keep their full
    // preview until approval ends, including across controller disconnections.
    if (
      bytes > 4000000 ||
      this.fileChangeBytes + bytes > 8000000 ||
      this.fileChanges.size >= 32
    )
      return;
    this.fileChanges.set(key, {
      session: s.id,
      bytes,
      item: JSON.parse(encoded),
    });
    this.fileChangeBytes += bytes;
  }
  async prepare() {
    requireThat(
      !this.core.storage.all("container").length,
      "LEGACY_CONTAINER_RECOVERY_REQUIRED",
    );
    requireThat(
      !this.core.storage.all("nativeActivity").length,
      "NATIVE_ACTIVITY_RECONCILIATION_REQUIRED",
    );
    this.command = await codexCommand(this.explicit);
    const { stdout } = await exec(
      this.command.command,
      [...this.command.prefix, "--version"],
      { timeout: 5000, maxBuffer: 4096, windowsHide: true },
    );
    requireThat(
      /^codex(?:-cli)? 0\.153\.4\s*$/.test(stdout.trim()),
      "CODEX_VERSION_UNVERIFIED",
    );
  }
  project(s) {
    const p = this.core.projects.find((p) => p.id === s.project);
    requireThat(p, "PROJECT_NOT_FOUND");
    return p;
  }
  validateSettings(value) {
    fields(value, [
      "model",
      "reasoningEffort",
      "permissionMode",
      "collaborationMode",
    ]);
    if (value.model !== undefined) string(value.model, 200);
    if (value.reasoningEffort !== undefined) string(value.reasoningEffort, 50);
    if (value.permissionMode !== undefined)
      requireThat(
        this.capabilities.permissionModes.includes(value.permissionMode),
        "PERMISSION_MODE_INVALID",
      );
    if (value.collaborationMode !== undefined)
      requireThat(
        this.capabilities.collaborationModes.includes(value.collaborationMode),
        "COLLABORATION_MODE_INVALID",
      );
    return { ...value };
  }
  async spawn(p, s) {
    const command = this.command ?? (await codexCommand(this.explicit));
    const rpc = new StdioRpc(
      command.command,
      [
        ...command.prefix,
        ...DISABLED_FEATURES.flatMap((f) => ["--disable", f]),
        "-c",
        "notify=[]",
        ...(process.platform === "win32"
          ? ["-c", 'windows.sandbox="unelevated"']
          : []),
        "app-server",
      ],
      {
        cwd: p.path,
        env: this.env,
        timeoutMs: 45000,
        maxFrameBytes: 16000000,
        requestHandler: (method, params, id) =>
          s
            ? this.serverRequest(s, method, params, id)
            : Promise.reject(new Fault("UPSTREAM_REQUEST_UNAVAILABLE")),
      },
    );
    if (this.diagnostic) rpc.on("requestDiagnostic", this.diagnostic);
    try {
      await rpc.request("initialize", {
        clientInfo: {
          name: "remotedesk_bridge",
          title: "RemoteDesk",
          version: "0.3.0",
        },
        capabilities: { experimentalApi: true },
      });
      rpc.notify("initialized");
      return rpc;
    } catch (e) {
      await rpc.close();
      throw e;
    }
  }
  async models(p, { cursor } = {}) {
    const rpc = await this.spawn(p);
    try {
      const effective = await rpc.request("config/read", {
        cwd: p.path,
        includeLayers: false,
      });
      const provider =
        p.provider ??
        this.providerOverrides?.model_provider ??
        effective.config?.model_provider ??
        "openai";
      if (provider !== "openai") {
        requireThat(!cursor, "CURSOR_INVALID");
        const model =
          p.model ?? this.providerOverrides?.model ?? effective.config?.model;
        return {
          data: model
            ? [
                {
                  id: model,
                  model,
                  provider,
                  displayName: model,
                  inputModalities: p.vision ? ["text", "image"] : ["text"],
                  supportedReasoningEfforts: [],
                  defaultReasoningEffort: null,
                },
              ]
            : [],
          nextCursor: null,
          source: "configured-project-model",
          dynamicCatalog: false,
        };
      }
      const page = await rpc.request("model/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      return { ...page, data: page.data.map((m) => ({ ...m, provider })) };
    } finally {
      await rpc.close();
    }
  }
  async connect(
    s,
    p = this.project(s),
    { allowCreate = false, authorize = () => {} } = {},
  ) {
    requireThat(
      !this.closed && (!this.closing || this.rpcs.has(s.id)),
      "ADAPTER_DISPOSED",
    );
    requireThat(
      !this.blocked.has(s.id),
      "NATIVE_ACTIVITY_RECONCILIATION_REQUIRED",
    );
    requireThat(
      s.upstream || allowCreate,
      "NATIVE_SESSION_RECONCILIATION_REQUIRED",
    );
    requireThat((await realpath(p.path)) === p.path, "PROJECT_PATH_CHANGED");
    if (this.rpcs.has(s.id)) return this.rpcs.get(s.id);
    requireThat(!this.closed && !this.closing, "ADAPTER_DISPOSED");
    if (this.loading.has(s.id)) return this.loading.get(s.id);
    if (this.rpcs.size + this.loading.size >= 8) {
      const id = [...this.rpcs.keys()].find(
        (id) =>
          !this.runs.has(id) && !this.core.storage.get("nativeActivity", id),
      );
      if (id) await this.deactivate(this.sessions.get(id));
    }
    requireThat(this.rpcs.size + this.loading.size < 8, "ENGINE_SESSION_LIMIT");
    const pending = this.open(s, p, authorize);
    this.loading.set(s.id, pending);
    try {
      return await pending;
    } finally {
      this.loading.delete(s.id);
    }
  }
  async parameters(rpc, s, p) {
    const { config: effective } = await rpc.request("config/read", {
      cwd: p.path,
      includeLayers: false,
    });
    const profile = "remotedesk-" + randomUUID();
    const mode = s.permissionMode ?? "read-only";
    const model =
      s.model ?? p.model ?? this.providerOverrides?.model ?? effective?.model;
    const provider =
      s.provider ??
      p.provider ??
      this.providerOverrides?.model_provider ??
      effective?.model_provider ??
      "openai";
    return {
      profile,
      mode,
      params: {
        cwd: p.path,
        approvalPolicy: APPROVAL_POLICY,
        approvalsReviewer: "user",
        config: {
          ...remoteConfig(
            profile,
            Object.keys(effective?.mcp_servers ?? {}),
            Object.keys(effective?.shell_environment_policy?.set ?? {}),
            mode,
          ),
          ...this.providerOverrides,
          ...(s.reasoningEffort
            ? { model_reasoning_effort: s.reasoningEffort }
            : {}),
        },
        ...(model ? { model } : {}),
        modelProvider: provider,
        allowProviderModelFallback: false,
        developerInstructions:
          "This is a RemoteDesk session for the authorized project. Use the native Codex tools, sandbox and approval flow. The controller receives tool output, approval prompts and questions. Do not claim a cancelled turn has stopped untracked detached processes. Extensions and delegation are unavailable in this remote session.",
      },
    };
  }
  verify(result, profile, mode) {
    requireThat(
      result.activePermissionProfile?.id === profile &&
        result.sandbox?.networkAccess === false &&
        result.sandbox?.type ===
          (mode === "read-only" ? "readOnly" : "workspaceWrite") &&
        result.approvalPolicy === APPROVAL_POLICY &&
        result.approvalsReviewer === "user",
      "EXECUTION_PROFILE_MISMATCH",
    );
  }
  async open(s, p, authorize = () => {}) {
    const rpc = await this.spawn(p, s);
    const buffered = [];
    let live = false,
      bufferedBytes = 0;
    rpc.on("notification", (event) => {
      if (live) this.notification(s, event);
      else {
        bufferedBytes += Buffer.byteLength(JSON.stringify(event));
        if (bufferedBytes <= 8000000) buffered.push(event);
      }
    });
    let dispatched = false;
    try {
      const { params, profile, mode } = await this.parameters(rpc, s, p);
      authorize();
      dispatched = true;
      const result = await rpc.request(
        s.upstream ? "thread/resume" : "thread/start",
        s.upstream
          ? { ...params, threadId: s.upstream, excludeTurns: true }
          : params,
      );
      const wasNew = !s.upstream;
      this.checkpoint(s, {
        upstream: result.thread.id,
        nativePhase: "configuring",
      });
      this.verify(result, profile, mode);
      if (wasNew)
        await rpc.request("thread/section/move", {
          threadId: result.thread.id,
          sectionId: null,
        });
      Object.assign(s, {
        upstream: result.thread.id,
        model: result.model,
        provider: result.modelProvider,
        executionProfile: "native-v1",
        permissionMode: mode,
        collaborationMode: s.collaborationMode ?? "default",
      });
      let cursor,
        count = 0,
        modelInfo;
      do {
        const page = await rpc.request("model/list", {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        modelInfo = page.data.find((m) => m.model === s.model);
        cursor = page.nextCursor;
        requireThat(++count <= 10, "MODEL_CATALOG_LIMIT");
      } while (!modelInfo && cursor);
      s.inputModalities =
        p.vision === true
          ? ["text", "image"]
          : p.vision === false
            ? ["text"]
            : (modelInfo?.inputModalities ?? ["text"]);
      s.reasoningEffort ??= modelInfo?.defaultReasoningEffort;
      if (s.reasoningEffort && modelInfo)
        requireThat(
          modelInfo.supportedReasoningEfforts.some(
            (e) => e.reasoningEffort === s.reasoningEffort,
          ),
          "REASONING_EFFORT_UNSUPPORTED",
        );
      cursor = undefined;
      count = 0;
      do {
        const page = await rpc.request("mcpServerStatus/list", {
          threadId: s.upstream,
          detail: "toolsAndAuthOnly",
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        requireThat(
          page.data.every((server) => server.runtimeStatus === "disabled"),
          "MCP_ISOLATION_FAILED",
        );
        cursor = page.nextCursor;
        requireThat(++count <= 10, "MCP_INVENTORY_LIMIT");
      } while (cursor);
      requireThat(!this.closed && !this.closing, "ADAPTER_DISPOSED");
      this.rpcs.set(s.id, rpc);
      this.sessions.set(s.id, s);
      this.checkpoint(s, { nativePhase: "ready" });
      live = true;
      for (const event of buffered) this.notification(s, event);
      if (bufferedBytes > 8000000)
        this.core.emit(s.id, {
          type: "snapshot.required",
          reason: "INITIAL_EVENTS_TOO_LARGE",
        });
      return rpc;
    } catch (e) {
      await rpc.close();
      this.clearFileChanges(s);
      if (dispatched) {
        this.checkpoint(s, { nativePhase: "unknown" });
        throw new Error("NATIVE_SESSION_OUTCOME_UNKNOWN", { cause: e });
      }
      throw e;
    }
  }
  metadata(s) {
    return Object.fromEntries(
      [
        "upstream",
        "model",
        "provider",
        "reasoningEffort",
        "inputModalities",
        "executionProfile",
        "permissionMode",
        "collaborationMode",
      ].map((k) => [k, s[k]]),
    );
  }
  async create(s, _project, authorize = () => {}) {
    authorize();
    await this.connect(s, this.project(s), { allowCreate: true, authorize });
    this.checkpoint(s, { nativePhase: "configuring" });
    try {
      authorize();
      if (s.title)
        await this.rpcs
          .get(s.id)
          .request("thread/name/set", { threadId: s.upstream, name: s.title });
      this.checkpoint(s, { nativePhase: "ready" });
      return this.metadata(s);
    } catch (e) {
      this.checkpoint(s, { nativePhase: "unknown" });
      throw new Error("NATIVE_CREATE_OUTCOME_UNKNOWN", { cause: e });
    }
  }
  async storedRequest(s, method, params, authorize = () => {}) {
    requireThat(!this.closed && !this.closing, "ADAPTER_DISPOSED");
    const p = this.project(s);
    requireThat((await realpath(p.path)) === p.path, "PROJECT_PATH_CHANGED");
    const rpc = await this.spawn(p);
    try {
      authorize();
      return await rpc.request(method, { threadId: s.upstream, ...params });
    } finally {
      await rpc.close();
    }
  }
  async archiveState(s) {
    const p = this.project(s),
      rpc = await this.spawn(p);
    try {
      for (const archived of [true, false]) {
        let cursor,
          count = 0;
        do {
          const page = await rpc.request("thread/list", {
            cwd: p.path,
            archived,
            modelProviders: [],
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          if (page.data.some((row) => row.id === s.upstream)) return archived;
          cursor = page.nextCursor;
          requireThat(++count <= 100, "NATIVE_HISTORY_RECONCILIATION_LIMIT");
        } while (cursor);
      }
      throw new Fault("NATIVE_SESSION_RECONCILIATION_REQUIRED");
    } finally {
      await rpc.close();
    }
  }
  async resume(s, authorize = () => {}) {
    if (s.nativeArchivePending)
      this.checkpoint(s, {
        nativeArchived: await this.archiveState(s),
        nativeArchivePending: false,
      });
    if (s.nativeArchived) {
      this.checkpoint(s, {
        nativePhase: "unarchiving",
        nativeArchivePending: true,
      });
      await this.storedRequest(s, "thread/unarchive", {}, authorize);
      this.checkpoint(s, {
        nativeArchived: false,
        nativeArchivePending: false,
      });
    }
    await this.connect(s, this.project(s), { authorize });
  }
  async archive(s, authorize = () => {}) {
    await this.quiescent(s);
    if (s.nativeArchivePending)
      this.checkpoint(s, {
        nativeArchived: await this.archiveState(s),
        nativeArchivePending: false,
      });
    if (s.nativeArchived) {
      this.checkpoint(s, { nativePhase: "ready" });
      return;
    }
    const rpc = await this.connect(s);
    authorize();
    this.checkpoint(s, {
      nativePhase: "archiving",
      nativeArchivePending: true,
    });
    try {
      await rpc.request("thread/archive", { threadId: s.upstream });
      this.checkpoint(s, {
        nativeArchived: true,
        nativeArchivePending: false,
        nativePhase: "ready",
      });
    } finally {
      await rpc.close();
      this.rpcs.delete(s.id);
      this.sessions.delete(s.id);
    }
  }
  async read(s, { cursor } = {}) {
    const params = {
      threadId: s.upstream,
      limit: 20,
      sortDirection: "desc",
      itemsView: "full",
      ...(cursor ? { cursor } : {}),
    };
    const turns =
      s.archived || s.nativeArchived
        ? await this.storedRequest(s, "thread/turns/list", params)
        : await (await this.connect(s)).request("thread/turns/list", params);
    return {
      ...this.metadata(s),
      status: this.runs.has(s.id)
        ? "running"
        : this.core.storage.get("nativeActivity", s.id)
          ? "background"
          : "idle",
      nativeState: this.core.storage.get("nativeState", s.id) ?? {},
      turns: turns.data,
      nextCursor: turns.nextCursor ?? null,
    };
  }
  async items(s, { turnId, cursor } = {}) {
    string(turnId, 500);
    const params = {
      threadId: s.upstream,
      turnId,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    };
    return s.archived || s.nativeArchived
      ? this.storedRequest(s, "thread/items/list", params)
      : (await this.connect(s)).request("thread/items/list", params);
  }
  async update(s, settings, authorize = () => {}) {
    await this.quiescent(s);
    const rpc = await this.connect(s);
    authorize();
    this.checkpoint(s, { nativePhase: "updating" });
    try {
      if (settings.title !== undefined) {
        await rpc.request("thread/name/set", {
          threadId: s.upstream,
          name: settings.title,
        });
        this.checkpoint(s, { title: settings.title });
      }
      this.checkpoint(s, settings);
      await this.deactivate(s);
      authorize();
      await this.connect(s, this.project(s), { authorize });
      this.checkpoint(s, { nativePhase: "ready" });
      return {
        ...this.metadata(s),
        ...(settings.title !== undefined ? { title: settings.title } : {}),
      };
    } catch (e) {
      this.checkpoint(s, { nativePhase: "unknown" });
      const uncertain = this.rpcs.get(s.id);
      if (uncertain) {
        try {
          await uncertain.close();
          this.rpcs.delete(s.id);
          this.sessions.delete(s.id);
        } catch {
          this.blocked.add(s.id);
          this.core.storage.put("nativeActivity", s.id, {
            id: s.id,
            project: s.project,
            upstream: s.upstream,
            scope: "reconfiguration-cleanup-unconfirmed",
          });
        }
      }
      throw new Error("NATIVE_SESSION_OUTCOME_UNKNOWN", { cause: e });
    }
  }
  async fork(s, child, { lastTurnId } = {}, authorize = () => {}) {
    const p = this.project(s),
      rpc = await this.spawn(p, child);
    try {
      const { params, profile, mode } = await this.parameters(rpc, child, p);
      authorize();
      const result = await rpc.request("thread/fork", {
        ...params,
        threadId: s.upstream,
        ...(lastTurnId ? { lastTurnId } : {}),
        excludeTurns: true,
      });
      this.checkpoint(child, {
        upstream: result.thread.id,
        nativePhase: "configuring",
      });
      this.verify(result, profile, mode);
      await rpc.request("thread/name/set", {
        threadId: child.upstream,
        name: child.title,
      });
    } catch (e) {
      this.checkpoint(child, { nativePhase: "unknown" });
      throw new Error("NATIVE_FORK_OUTCOME_UNKNOWN", { cause: e });
    } finally {
      await rpc.close();
    }
    await this.connect(child);
    return this.metadata(child);
  }
  reserve(s, authorize = () => {}) {
    requireThat(!this.runs.has(s.id), "TURN_ALREADY_RUNNING");
    const run = {
      controller: new AbortController(),
      authorize,
      turnId: null,
      cancelRequested: false,
      finished: false,
    };
    run.ready = new Promise((resolve) => {
      run.readyResolve = resolve;
    });
    run.done = new Promise((resolve) => {
      run.doneResolve = resolve;
    });
    this.runs.set(s.id, run);
    this.core.storage.put("nativeActivity", s.id, {
      id: s.id,
      project: s.project,
      upstream: s.upstream,
      started: Date.now(),
      scope: "native-managed-terminals",
    });
    return run;
  }
  async start(s, text, attachments = [], settings = {}, authorize = () => {}) {
    if (Object.keys(settings).length) await this.update(s, settings, authorize);
    const rpc = await this.connect(s);
    requireThat(!this.closed && !this.closing, "ADAPTER_DISPOSED");
    authorize();
    const run = this.reserve(s, authorize);
    try {
      requireThat(
        !attachments.some((a) => a.mime !== "text/plain") ||
          s.inputModalities?.includes("image"),
        "MODEL_IMAGE_CAPABILITY_UNDECLARED",
      );
      const input = [
        { type: "text", text },
        ...attachments.map((a) =>
          a.mime === "text/plain"
            ? {
                type: "text",
                text: Buffer.from(a.data, "base64").toString("utf8"),
              }
            : { type: "image", url: `data:${a.mime};base64,${a.data}` },
        ),
      ];
      requireThat(!run.cancelRequested, "TURN_CANCELLED_BEFORE_DISPATCH");
      run.dispatched = true;
      const result = await rpc.request("turn/start", {
        threadId: s.upstream,
        input,
        model: s.model,
        ...(s.reasoningEffort ? { effort: s.reasoningEffort } : {}),
        collaborationMode: {
          mode: s.collaborationMode ?? "default",
          settings: {
            model: s.model,
            reasoning_effort: s.reasoningEffort ?? null,
            developer_instructions: null,
          },
        },
        clientUserMessageId: randomUUID(),
      });
      run.turnId ??= result.turn.id;
      run.readyResolve();
      if (run.cancelRequested && !run.finished) await this.interrupt(s, run);
      return { turnId: result.turn.id, cancelRequested: run.cancelRequested };
    } catch (e) {
      if (!run.dispatched) {
        this.runs.delete(s.id);
        this.core.storage.delete("nativeActivity", s.id);
        run.doneResolve();
      }
      throw e;
    } finally {
      run.readyResolve();
    }
  }
  async compact(s, authorize = () => {}) {
    const rpc = await this.connect(s);
    requireThat(!this.closed && !this.closing, "ADAPTER_DISPOSED");
    authorize();
    const run = this.reserve(s, authorize);
    try {
      run.dispatched = true;
      await rpc.request("thread/compact/start", { threadId: s.upstream });
      return { accepted: true };
    } finally {
      run.readyResolve();
    }
  }
  finish(s, run) {
    if (run.finishPromise) return run.finishPromise;
    run.finished = true;
    run.controller.abort();
    this.clearFileChanges(s);
    run.finishPromise = (async () => {
      try {
        const background = await this.allTerminals(s);
        if (!background.length)
          this.core.storage.delete("nativeActivity", s.id);
        if (this.runs.get(s.id) === run) this.runs.delete(s.id);
        this.core.emit(s.id, {
          type: background.length ? "execution.background" : "execution.idle",
          processScope: "native-managed-terminals",
        });
      } catch {
        this.core.emit(s.id, {
          type: "execution.blocked",
          reason: "NATIVE_ACTIVITY_RECONCILIATION_REQUIRED",
        });
      } finally {
        run.doneResolve();
      }
    })();
    return run.finishPromise;
  }
  async terminals(s, { cursor } = {}) {
    if (s.nativeArchived) return { data: [], nextCursor: null };
    return (await this.connect(s)).request("thread/backgroundTerminals/list", {
      threadId: s.upstream,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
  }
  async allTerminals(s) {
    const rows = [];
    let cursor,
      count = 0;
    do {
      const page = await this.terminals(s, { cursor });
      rows.push(...page.data);
      cursor = page.nextCursor;
      requireThat(++count <= 10, "TERMINAL_LIMIT");
    } while (cursor);
    return rows;
  }
  async stopTerminal(s, processId) {
    const rpc = await this.connect(s);
    const result = await rpc.request("thread/backgroundTerminals/terminate", {
      threadId: s.upstream,
      processId,
    });
    requireThat(result.terminated, "TERMINAL_NOT_FOUND");
    const rows = await this.allTerminals(s);
    requireThat(
      !rows.some((row) => row.processId === processId),
      "TERMINAL_STOP_UNCONFIRMED",
    );
    if (!rows.length && !this.runs.has(s.id)) {
      this.core.storage.delete("nativeActivity", s.id);
      this.core.emit(s.id, { type: "execution.idle" });
    }
    return result;
  }
  async quiescent(s) {
    requireThat(!this.runs.has(s.id), "TURN_NOT_QUIESCENT");
    if (this.rpcs.has(s.id))
      requireThat(
        !(await this.allTerminals(s)).length,
        "BACKGROUND_TERMINALS_ACTIVE",
      );
    requireThat(
      !this.core.storage.get("nativeActivity", s.id),
      "NATIVE_ACTIVITY_RECONCILIATION_REQUIRED",
    );
  }
  async interrupt(s, run) {
    if (run.finished) return;
    run.interruptPromise ??= (async () => {
      const rpc = this.rpcs.get(s.id);
      const end = Date.now() + 5000;
      for (;;) {
        if (run.finished) return;
        try {
          await rpc.request("turn/interrupt", {
            threadId: s.upstream,
            turnId: run.turnId ?? "",
          });
          return;
        } catch (e) {
          if (!run.turnId || e.upstreamCode !== -32600) throw e;
          const page = await rpc.request("thread/turns/list", {
            threadId: s.upstream,
            limit: 20,
            itemsView: "summary",
            sortDirection: "desc",
          });
          const turn = page.data.find((t) => t.id === run.turnId);
          if (
            turn &&
            ["completed", "interrupted", "failed"].includes(turn.status)
          ) {
            await this.finish(s, run);
            return;
          }
          // turn/start acknowledges before the native loop necessarily owns the
          // turn. Retry only interruption of this same known, pending turn.
          if (turn?.status !== "inProgress" || Date.now() >= end) throw e;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    })();
    await run.interruptPromise;
  }
  async steer(s, text) {
    const run = this.runs.get(s.id);
    requireThat(
      run?.turnId && !run.cancelRequested && !run.finished,
      "NO_ACTIVE_TURN",
    );
    return this.rpcs.get(s.id).request("turn/steer", {
      threadId: s.upstream,
      expectedTurnId: run.turnId,
      input: [{ type: "text", text }],
      clientUserMessageId: randomUUID(),
    });
  }
  async cancel(s) {
    if (!s) return;
    const run = this.runs.get(s.id);
    if (run) {
      run.cancelRequested = true;
      run.controller.abort();
      await run.ready;
      await this.interrupt(s, run);
      await deadline(run.done, 20000, "CANCEL_DID_NOT_SETTLE");
    }
    if (this.rpcs.has(s.id)) {
      for (const terminal of await this.allTerminals(s))
        await this.stopTerminal(s, terminal.processId);
      requireThat(
        !(await this.allTerminals(s)).length,
        "TERMINAL_STOP_UNCONFIRMED",
      );
    }
    requireThat(!this.runs.has(s.id), "TURN_NOT_QUIESCENT");
    this.core.storage.delete("nativeActivity", s.id);
  }
  async diff(s) {
    return (
      this.core.storage.get("nativeDiff", s.id) ?? {
        diff: "",
        scope: "latest-native-turn",
        available: false,
      }
    );
  }
  notification(s, { method, params }) {
    if (params?.threadId !== s.upstream) return;
    if (method === "item/started" && params.item?.type === "fileChange")
      this.rememberFileChange(s, params);
    if (method === "item/completed" && params.item?.type === "fileChange")
      this.dropFileChange(this.fileChangeKey(s, params.turnId, params.item.id));
    if (method === "serverRequest/resolved")
      this.pending.get(`${s.id}:${params.requestId}`)?.abort();
    if (method === "turn/diff/updated")
      this.core.storage.put("nativeDiff", s.id, {
        diff: params.diff,
        turnId: params.turnId,
        scope: "latest-native-turn",
        available: true,
      });
    if (
      [
        "thread/tokenUsage/updated",
        "thread/status/changed",
        "thread/name/updated",
      ].includes(method)
    ) {
      const previous = this.core.storage.get("nativeState", s.id) ?? {};
      this.core.storage.put("nativeState", s.id, {
        ...previous,
        [method.split("/")[1]]: params,
      });
    }
    const run = this.runs.get(s.id);
    if (method === "turn/started" && run) run.turnId = params.turn.id;
    if (
      method === "turn/completed" &&
      run &&
      (!run.turnId || run.turnId === params.turn.id)
    )
      void this.finish(s, run);
    if (
      /^(turn\/|item\/|thread\/(tokenUsage|status|name)\/|error$)/.test(method)
    )
      this.core.emit(s.id, { type: method, params });
  }
  validateAnswer(request, answer) {
    validateNativeAnswer(request, answer);
  }
  async serverRequest(s, method, params, requestId) {
    const run = this.runs.get(s.id);
    requireThat(
      params?.threadId === s.upstream &&
        run &&
        !run.finished &&
        !run.cancelRequested &&
        (!run.turnId || params.turnId === run.turnId),
      "UPSTREAM_REQUEST_STALE",
    );
    run.turnId ??= params.turnId;
    const kinds = {
      "item/commandExecution/requestApproval": "command",
      "item/fileChange/requestApproval": "fileChange",
      "item/permissions/requestApproval": "permissions",
      "item/tool/requestUserInput": "questions",
    };
    const kind = kinds[method];
    requireThat(kind, "UPSTREAM_METHOD_UNSUPPORTED");
    const fileKey =
      kind === "fileChange"
        ? this.fileChangeKey(s, params.turnId, params.itemId)
        : null;
    const nativeItem = fileKey ? this.fileChanges.get(fileKey)?.item : null;
    if (kind === "fileChange" && !nativeItem) {
      this.core.emit(s.id, {
        type: "approval.unavailable",
        reason: "NATIVE_FILE_CHANGE_PREVIEW_UNAVAILABLE",
        itemId: params.itemId,
      });
      return { decision: "cancel" };
    }
    if (kind === "questions" && params.questions.some((q) => q.isSecret)) {
      this.core.emit(s.id, {
        type: "question.unavailable",
        reason: "HOST_SECRET_INPUT_REQUIRED",
      });
      return { answers: {} };
    }
    const controller = new AbortController(),
      key = `${s.id}:${requestId}`;
    this.pending.set(key, controller);
    const abort = () => controller.abort();
    run.controller.signal.addEventListener("abort", abort, { once: true });
    try {
      const request = {
        kind,
        engine: "codex",
        nativeMethod: method,
        ...params,
        ...(nativeItem ? { nativeItem, nativeItemComplete: true } : {}),
        ...(kind === "permissions"
          ? { grantScope: "turn", requiresExplicitScope: true }
          : { grantScope: "once" }),
      };
      const answer = await this.core.ask(s.id, request, controller.signal);
      requireThat(
        !controller.signal.aborted &&
          this.runs.get(s.id) === run &&
          !run.finished &&
          !run.cancelRequested,
        "UPSTREAM_REQUEST_STALE",
      );
      run.authorize();
      if (kind === "permissions")
        return {
          permissions: answer.decision === "accept" ? params.permissions : {},
          scope: "turn",
        };
      return answer;
    } catch {
      return kind === "questions"
        ? { answers: {} }
        : kind === "permissions"
          ? { permissions: {}, scope: "turn" }
          : { decision: "cancel" };
    } finally {
      run.controller.signal.removeEventListener("abort", abort);
      this.pending.delete(key);
      if (fileKey) this.dropFileChange(fileKey);
    }
  }
  async deactivate(s) {
    await this.quiescent(s);
    const rpc = this.rpcs.get(s.id);
    if (rpc) {
      await rpc.request("thread/unsubscribe", { threadId: s.upstream });
      await rpc.close();
      this.rpcs.delete(s.id);
      this.sessions.delete(s.id);
      this.clearFileChanges(s);
    }
  }
  close() {
    return (this.closePromise ??= this.closeInternal());
  }
  async closeInternal() {
    if (this.closed) return;
    this.closing = true;
    await Promise.allSettled([...this.loading.values()]);
    const results = await Promise.allSettled(
      [...this.sessions.values()].map(async (s) => {
        await this.cancel(s);
        await this.deactivate(s);
      }),
    );
    this.closed = true;
    this.fileChanges.clear();
    this.fileChangeBytes = 0;
    if (results.some((r) => r.status === "rejected")) {
      await Promise.allSettled([...this.rpcs.values()].map((r) => r.close()));
      throw new Fault("NATIVE_ACTIVITY_RECONCILIATION_REQUIRED");
    }
  }
}
