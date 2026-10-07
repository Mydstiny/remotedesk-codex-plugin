import { createRequire } from "node:module";
import { X509Certificate, createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const qrcode = require("./vendor/qrcode-generator-2.0.4.cjs");

export function inviteQrDataUrl(invite) {
  const svg = inviteQrSvg(invite);
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}

/**
 * The QR carries the compact invite: the CA's SHA-256 instead of the CA itself (about 190 bytes instead of 1.7 KB),
 * so the code stays scannable on small or low-resolution screens. RemoteDesk takes the CA from this server's TLS
 * chain only when its fingerprint matches. The pairing link keeps the full invite.
 */
export function compactInviteText(invite) {
  return JSON.stringify({
    caSha256: createHash("sha256").update(new X509Certificate(invite.ca).raw).digest("base64url"),
    code: invite.code,
    expires: invite.expires,
    serverInstance: invite.serverInstance,
  });
}

export function inviteQrSvg(invite) {
  const qr = qrcode(0, "M");
  qr.addData(compactInviteText(invite), "Byte");
  qr.make();
  return qr.createSvgTag(4, 4);
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
