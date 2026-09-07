import { withLifecycleLock } from "./lifecycle-lock.mjs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { requireThat } from "./errors.mjs";
const exec = promisify(execFile),
  xml = (s) =>
    String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
const unit = (s) =>
  '"' +
  s
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$") +
  '"';
const win = (s) =>
  '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"';
export function serviceDefinition({
  engine,
  entry,
  state,
  platform = process.platform,
  node = process.execPath,
  user = homedir(),
  path = process.env.PATH ?? "",
  userSid,
}) {
  requireThat(["codex", "dsh"].includes(engine));
  for (const v of [entry, state, node, user, path])
    requireThat(
      typeof v === "string" && !/[\0\r\n]/.test(v),
      "SERVICE_VALUE_INVALID",
    );
  const id =
      `com.remotedesk.${engine}.` +
      createHash("sha256").update(resolve(state)).digest("hex").slice(0, 12),
    args = [entry, "serve", "--state", state],
    environment = {
      PATH: path,
      ...(process.env.DSH_HOME ? { DSH_HOME: process.env.DSH_HOME } : {}),
    };
  if (platform === "darwin")
    return {
      id,
      path: join(user, "Library", "LaunchAgents", id + ".plist"),
      text: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${id}</string><key>ProgramArguments</key><array>${[node, ...args].map((v) => "<string>" + xml(v) + "</string>").join("")}</array><key>EnvironmentVariables</key><dict>${Object.entries(
        environment,
      )
        .map(
          ([k, v]) =>
            "<key>" + xml(k) + "</key><string>" + xml(v) + "</string>",
        )
        .join(
          "",
        )}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>ProcessType</key><string>Background</string><key>ExitTimeOut</key><integer>45</integer><key>StandardOutPath</key><string>${xml(join(state, "service.log"))}</string><key>StandardErrorPath</key><string>${xml(join(state, "service.log"))}</string></dict></plist>\n`,
    };
  if (platform === "linux")
    return {
      id,
      path: join(user, ".config", "systemd", "user", id + ".service"),
      text: `[Unit]\nDescription=RemoteDesk ${engine} bridge\n[Service]\nType=simple\nExecStart=${[node, ...args].map(unit).join(" ")}\n${Object.entries(
        environment,
      )
        .map(([k, v]) => "Environment=" + unit(k + "=" + v))
        .join(
          "\n",
        )}\nRestart=no\nTimeoutStopSec=45\nKillMode=control-group\nUMask=0077\n[Install]\nWantedBy=default.target\n`,
    };
  requireThat(platform === "win32", "PLATFORM_UNSUPPORTED");
  requireThat(
    /^S-1-(?:[0-9]+-)*[0-9]+$/.test(userSid ?? ""),
    "WINDOWS_USER_SID_REQUIRED",
  );
  // InteractiveToken uses the current signed-in user's existing provider access;
  // no stored account password, elevated token, SYSTEM identity, or boot service.
  return {
    id,
    path: join(state, "service.xml"),
    text: `\uFEFF<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(userSid)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(userSid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings><Actions Context="Author"><Exec><Command>${xml(node)}</Command><Arguments>${xml(args.map(win).join(" "))}</Arguments><WorkingDirectory>${xml(dirname(entry))}</WorkingDirectory></Exec></Actions></Task>\n`,
  };
}
export async function service(action, options) {
  if (["render", "status"].includes(action))
    return serviceInternal(action, options);
  return withLifecycleLock(
    options.state,
    () => serviceInternal(action, options),
    "service",
  );
}
async function serviceInternal(action, options) {
  const platform = process.platform;
  let userSid;
  if (platform === "win32")
    userSid = (
      await exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        ],
        { timeout: 15000, windowsHide: true, maxBuffer: 4096 },
      )
    ).stdout.trim();
  const def = serviceDefinition({ ...options, userSid });
  requireThat(
    ["render", "install", "start", "stop", "status", "uninstall"].includes(
      action,
    ),
    "SERVICE_ACTION_INVALID",
  );
  if (action === "render") return def;
  const call = (command, args) =>
    exec(command, args, {
      timeout: 60000,
      maxBuffer: 32000,
      windowsHide: true,
    });
  const run = async (command, args) => {
    try {
      return (await call(command, args)).stdout;
    } catch (e) {
      options.diagnostic?.({
        command,
        action: args[0],
        code: e.code,
        stderr: e.stderr,
      });
      throw new Error("SERVICE_COMMAND_FAILED_CHECK_NATIVE_MANAGER");
    }
  };
  const target = `gui/${process.getuid?.()}/${def.id}`,
    record = join(options.state, "service.json");
  const exists = async () => {
    if (platform === "darwin") {
      try {
        await call("launchctl", ["print", target]);
        return true;
      } catch (e) {
        if (e.code === 113) return false;
        throw new Error("SERVICE_MANAGER_UNAVAILABLE");
      }
    }
    if (platform === "linux") {
      const value = await run("systemctl", [
        "--user",
        "show",
        def.id + ".service",
        "--property=LoadState",
        "--value",
      ]);
      return value.trim() !== "not-found";
    }
    const query = `$ErrorActionPreference='Stop';$s=[Activator]::CreateInstance([Type]::GetTypeFromProgID('Schedule.Service'));$s.Connect();try{$t=$s.GetFolder('\\').GetTask('${def.id}');[Console]::WriteLine('EXISTS')}catch{if($_.Exception.HResult -eq -2147024894 -or $_.Exception.InnerException.HResult -eq -2147024894){[Console]::WriteLine('ABSENT')}else{exit 1}}`;
    const value = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(query, "utf16le").toString("base64"),
    ]);
    requireThat(
      ["EXISTS", "ABSENT"].includes(value.trim()),
      "SERVICE_MANAGER_UNAVAILABLE",
    );
    return value.trim() === "EXISTS";
  };
  let registered;
  try {
    registered = JSON.parse(await readFile(record, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (registered)
    requireThat(
      registered.id === def.id &&
        registered.path === def.path &&
        (action !== "install" ||
          (registered.entry === options.entry &&
            registered.node === process.execPath)),
      "SERVICE_REGISTRATION_MISMATCH",
    );
  if (action === "install") {
    await mkdir(dirname(def.path), { recursive: true });
    if (!registered) {
      requireThat(!(await exists()), "SERVICE_ALREADY_REGISTERED");
      registered = {
        id: def.id,
        path: def.path,
        entry: options.entry,
        node: process.execPath,
        environment: {
          PATH: process.env.PATH ?? "",
          ...(process.env.DSH_HOME ? { DSH_HOME: process.env.DSH_HOME } : {}),
        },
      };
      await writeFile(record, JSON.stringify(registered), {
        mode: 0o600,
        flag: "wx",
      });
    }
    // A failed native registration can be retried. Existing descriptors must be
    // this exact definition; no other service or version is ever overwritten.
    try {
      const old = await readFile(
        def.path,
        platform === "win32" ? "utf16le" : "utf8",
      );
      requireThat(old === def.text, "SERVICE_DEFINITION_CHANGED");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      await writeFile(def.path, def.text, {
        encoding: platform === "win32" ? "utf16le" : "utf8",
        mode: 0o600,
        flag: "wx",
      });
    }
    if (platform === "linux")
      await run("systemctl", ["--user", "daemon-reload"]);
    if (!(await exists())) {
      if (platform === "darwin")
        await run("launchctl", [
          "bootstrap",
          `gui/${process.getuid()}`,
          def.path,
        ]);
      if (platform === "linux") {
        await run("systemctl", ["--user", "daemon-reload"]);
        await run("systemctl", [
          "--user",
          "enable",
          "--now",
          def.id + ".service",
        ]);
      }
      if (platform === "win32")
        await run("schtasks.exe", ["/Create", "/TN", def.id, "/XML", def.path]);
    }
    if (platform === "linux")
      await run("systemctl", [
        "--user",
        "enable",
        "--now",
        def.id + ".service",
      ]);
    if (platform === "win32")
      await run("schtasks.exe", ["/Run", "/TN", def.id]);
    return { installed: true, id: def.id };
  }
  requireThat(registered, "SERVICE_NOT_REGISTERED");
  if (action === "stop" || action === "uninstall") {
    // Graceful stop handles a published controller. The startup gate then
    // excludes a process that has been spawned but has not published its lock.
    // Only in that pre-controller window may the native manager terminate it.
    for (;;) {
      await requestStop(options.state);
      const stopped = await withLifecycleLock(options.state, async () => {
        try {
          await readFile(join(options.state, "server.lock"));
          return false;
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        if (!(await exists())) return true;
        if (platform === "darwin")
          await run("launchctl", [
            "bootout",
            `gui/${process.getuid()}`,
            def.path,
          ]);
        if (platform === "linux")
          await run("systemctl", ["--user", "stop", def.id + ".service"]);
        if (platform === "win32") {
          const stopTask = `$ErrorActionPreference='Stop';$s=[Activator]::CreateInstance([Type]::GetTypeFromProgID('Schedule.Service'));$s.Connect();$t=$s.GetFolder('\\').GetTask('${def.id}');if($t.GetInstances(0).Count -gt 0 -or $t.State -eq 2){$t.Stop(0)};$end=[DateTime]::UtcNow.AddSeconds(15);do{if($t.GetInstances(0).Count -eq 0 -and $t.State -ne 2){exit 0};Start-Sleep -Milliseconds 100}while([DateTime]::UtcNow -lt $end);exit 1`;
          await run("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(stopTask, "utf16le").toString("base64"),
          ]);
        }
        return true;
      });
      if (stopped) break;
    }
    if (action === "stop") return { action, id: def.id, stopped: true };
  }
  let present = await exists();
  let result;
  if (!present && platform === "darwin") {
    if (action === "start") {
      await run("launchctl", [
        "bootstrap",
        `gui/${process.getuid()}`,
        def.path,
      ]);
      present = true;
    } else if (action === "status")
      return {
        action,
        id: def.id,
        nativeStatus: "Registered descriptor; currently stopped and unloaded.",
      };
  }
  if (action !== "uninstall")
    requireThat(present, "SERVICE_NOT_REGISTERED_RETRY_INSTALL");
  if (present) {
    if (platform === "darwin")
      result = await run(
        "launchctl",
        action === "status"
          ? ["print", target]
          : action === "start"
            ? ["kickstart", target]
            : ["bootout", `gui/${process.getuid()}`, def.path],
      );
    if (platform === "linux")
      result = await run("systemctl", [
        "--user",
        ...(action === "uninstall" ? ["disable", "--now"] : [action]),
        def.id + ".service",
      ]);
    if (platform === "win32")
      result = await run(
        "schtasks.exe",
        action === "status"
          ? ["/Query", "/TN", def.id, "/FO", "LIST"]
          : action === "start"
            ? ["/Run", "/TN", def.id]
            : ["/Delete", "/TN", def.id, "/F"],
      );
  }
  if (action === "uninstall") {
    await unlink(def.path).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    await unlink(record);
    if (platform === "linux")
      await run("systemctl", ["--user", "daemon-reload"]);
  }
  return {
    action,
    id: def.id,
    ...(action === "status" ? { nativeStatus: result } : {}),
  };
}

export async function requestStop(state) {
  const lock = join(state, "server.lock"),
    request = join(state, "stop.request");
  let owner;
  try {
    owner = JSON.parse(await readFile(lock, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  requireThat(
    Number.isSafeInteger(owner.pid) && owner.pid > 0,
    "LOCK_PID_INVALID",
  );
  try {
    process.kill(owner.pid, 0);
  } catch (e) {
    if (e.code === "ESRCH") throw new Error("SERVICE_CRASHED_RECOVER_REQUIRED");
    throw e;
  }
  await writeFile(request, JSON.stringify({ pid: owner.pid }), { mode: 0o600 });
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    let current;
    try {
      current = JSON.parse(await readFile(lock, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    requireThat(
      !current || current.pid === owner.pid,
      "SERVICE_PROCESS_CHANGED",
    );
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") alive = false;
      else throw e;
    }
    if (!alive) {
      requireThat(!current, "SERVICE_CRASHED_RECOVER_REQUIRED");
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("SERVICE_STOP_DID_NOT_SETTLE");
}
export function watchStopRequests(state) {
  let requested = false,
    busy = false;
  const file = join(state, "stop.request");
  const timer = setInterval(async () => {
    if (requested || busy) return;
    busy = true;
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (value.pid === process.pid && process.listenerCount("SIGTERM") > 0) {
        requested = true;
        await unlink(file);
        process.emit("SIGTERM");
      }
    } catch {
    } finally {
      busy = false;
    }
  }, 300);
  timer.unref();
  return () => clearInterval(timer);
}
