import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const qrcode = require("./vendor/qrcode-generator-2.0.4.cjs");

export function inviteQrDataUrl(invite) {
  const qr = qrcode(0, "M");
  qr.addData(JSON.stringify({
    code: invite.code,
    expires: invite.expires,
    ca: invite.ca,
    serverInstance: invite.serverInstance,
  }), "Byte");
  qr.make();
  return qr.createDataURL(4, 4);
}

export function invitePairingLink(invite, config, engine) {
  const host = typeof config?.host === "string" ? config.host.trim() : "";
  const port = Number(config?.port);
  const authority = host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host;
  const url = host !== "" && Number.isInteger(port) && port > 0 && port < 65536
    ? "https://" + authority + ":" + String(port)
    : "";
  const payload = {
    type: "remotedesk-pair",
    version: 1,
    engine,
    ...(url === "" ? {} : { url }),
    invite: {
      code: invite.code,
      expires: invite.expires,
      ca: invite.ca,
      serverInstance: invite.serverInstance,
    },
  };
  return "remotedesk://pair?data=" + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
