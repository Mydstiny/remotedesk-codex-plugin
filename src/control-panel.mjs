import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration, addProject, invite, revoke, status } from "../packages/bridge-core/lib/admin.mjs";
import { Store } from "../packages/bridge-core/lib/store.mjs";
import { privateDirectory } from "../packages/bridge-core/lib/privacy.mjs";
import { invitePairingLink, inviteQrDataUrl, inviteQrSvg } from "./qr-code.mjs";
import { controlPanelPage } from "./control-panel-page.mjs";

const MAX_BODY = 100 * 1024;
const DEFAULT_PORTS = { codex: 9543, dsh: 9544 };

function httpError(statusCode, error) {
  const candidate = error && typeof error === "object" ? error.code || error.message : undefined;
  const response = typeof candidate === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(candidate) ? candidate : undefined;
  return { statusCode, error: response || "PANEL_REQUEST_FAILED" };
}

function json(res, statusCode, value) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

function page(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(html);
}

function sameToken(expected, supplied) {
  if (typeof supplied !== "string" || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

function requestToken(req) {
  const authorization = req.headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : undefined;
}

function validOrigin(req, origin) {
  return !req.headers.origin || req.headers.origin === origin;
}

async function body(req) {
  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new Error("REQUEST_TOO_LARGE");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("JSON_OBJECT_REQUIRED");
    return parsed;
  } catch (error) {
    if (error.message === "JSON_OBJECT_REQUIRED") throw error;
    throw new Error("JSON_INVALID");
  }
}

async function serviceState(state) {
  let lock;
  try {
    lock = JSON.parse(await readFile(join(state, "server.lock"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { running: false, lock: "missing" };
    return { running: false, lock: "stale" };
  }
  const pid = lock && lock.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return { running: false, lock: "stale", pid };
  try {
    process.kill(pid, 0);
    return { running: true, lock: "active", pid };
  } catch (error) {
    return { running: false, lock: "stale", pid };
  }
}

async function snapshot(state, engine, panelPort) {
  const config = await configuration(state);
  const current = status(state);
  const store = new Store(state);
  let devices;
  try {
    devices = store.all("device").map((device) => {
      const expires = Number.isSafeInteger(device.expires) ? device.expires : null;
      return {
        id: device.id,
        name: device.name || "",
        projects: Array.isArray(device.projects) ? device.projects : [],
        role: device.role || "viewer",
        revoked: device.revoked === true,
        expires,
        status: device.revoked === true ? "revoked" : expires && expires <= Date.now() ? "expired" : "paired",
      };
    });
  } finally {
    store.close();
  }
  return {
    engine,
    panel: { host: "127.0.0.1", port: panelPort },
    service: { host: config.host, port: config.port, ...(await serviceState(state)) },
    projects: (config.projects || []).map((project) => ({
      id: project.id,
      path: project.path,
      title: project.title || project.id,
      provider: project.provider || "",
      model: project.model || "",
      vision: project.vision === true,
    })),
    devices,
    sessions: current.sessions,
    operations: current.operations,
  };
}

function validatePort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PANEL_PORT_INVALID");
}

export async function startControlPanel(state, { engine, port } = {}) {
  if (!["codex", "dsh"].includes(engine)) throw new Error("ENGINE_INVALID");
  await privateDirectory(state);
  const expectedPort = port === undefined ? DEFAULT_PORTS[engine] : Number(port);
  validatePort(expectedPort);
  const html = controlPanelPage(engine);
  const token = randomBytes(32).toString("base64url");
  let panelOrigin = "";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", panelOrigin || "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/") {
      page(res, html);
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      json(res, 404, { error: "PANEL_ROUTE_NOT_FOUND" });
      return;
    }
    if (!sameToken(token, requestToken(req)) || !validOrigin(req, panelOrigin)) {
      json(res, 401, { error: "PANEL_UNAUTHORIZED" });
      return;
    }
    try {
      if (req.method === "GET" && url.pathname === "/api/status") {
        json(res, 200, await snapshot(state, engine, server.address().port));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/project") {
        const input = await body(req);
        if (typeof input.id !== "string" || typeof input.path !== "string")
          throw new Error("PROJECT_ARGUMENTS_REQUIRED");
        const project = { id: input.id, path: input.path };
        for (const key of ["title", "provider", "model"])
          if (input[key] !== undefined) project[key] = input[key];
        if (input.vision !== undefined) {
          if (typeof input.vision !== "boolean") throw new Error("VISION_VALUE_INVALID");
          project.vision = input.vision;
        }
        json(res, 200, { project: await addProject(state, project) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/invite") {
        const input = await body(req);
        if (!Array.isArray(input.projects) || !input.projects.length)
          throw new Error("PROJECTS_REQUIRED");
        const role = input.role === undefined ? "operator" : input.role;
        if (!["viewer", "operator"].includes(role)) throw new Error("ROLE_INVALID");
        const created = await invite(state, { projects: input.projects, role });
        const config = await configuration(state);
        json(res, 200, {
          invite: created,
          qr: inviteQrDataUrl(created),
          qrSvg: inviteQrSvg(created),
          pairingLink: invitePairingLink(created, config, "codex"),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/revoke") {
        const input = await body(req);
        if (typeof input.device !== "string" || !input.device)
          throw new Error("DEVICE_REQUIRED");
        json(res, 200, { result: revoke(state, input.device) });
        return;
      }
      json(res, 404, { error: "PANEL_ROUTE_NOT_FOUND" });
    } catch (error) {
      const response = httpError(error && (error.code || error.message) ? 400 : 500, error);
      json(res, response.statusCode, response);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(expectedPort, "127.0.0.1", resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : expectedPort;
  panelOrigin = "http://127.0.0.1:" + actualPort;
  return {
    server,
    token,
    port: actualPort,
    url: panelOrigin + "/?token=" + encodeURIComponent(token),
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export async function runControlPanel(state, { engine, port } = {}) {
  const panel = await startControlPanel(state, { engine, port });
  console.log(
    JSON.stringify({
      ready: true,
      engine,
      bind: "127.0.0.1",
      port: panel.port,
      url: panel.url,
    }),
  );
  await new Promise((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await panel.close();
}
