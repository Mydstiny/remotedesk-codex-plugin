import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate, createHash } from "node:crypto";
import { compactInviteText, invitePairingLink, inviteQrDataUrl, inviteQrSvg } from "../src/qr-code.mjs";

function fixtureCa() {
  const dir = mkdtempSync(join(tmpdir(), "remotedesk-qr-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-keyout", join(dir, "ca.key"),
      "-out", join(dir, "ca.pem"), "-days", "1", "-subj", "/CN=RemoteDesk private CA",
      "-addext", "basicConstraints=critical,CA:TRUE"], { stdio: "ignore" });
    return readFileSync(join(dir, "ca.pem"), "utf8");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("pairing QR carries the compact invite and the link the exact invite fields", () => {
  const invite = {
    code: "invite-code-0123456789",
    expires: Date.now() + 120000,
    ca: fixtureCa(),
    serverInstance: "server-instance-0123456789",
  };
  const qr = inviteQrDataUrl(invite);
  assert.match(qr, /^data:image\/svg\+xml;base64,/);
  assert.match(inviteQrSvg(invite), /^<svg /);
  const compact = JSON.parse(compactInviteText(invite));
  assert.deepEqual(Object.keys(compact).sort(), ["caSha256", "code", "expires", "serverInstance"]);
  assert.equal(compact.caSha256, createHash("sha256").update(new X509Certificate(invite.ca).raw).digest("base64url"));
  assert.match(compact.caSha256, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(compactInviteText(invite).length < 200, "small enough to scan on low-resolution screens");
  const link = invitePairingLink(invite, { host: "192.168.1.10", port: 9443 }, "codex");
  assert.match(link, /^remotedesk:\/\/pair\?data=/);
  const payload = JSON.parse(Buffer.from(link.split("data=")[1], "base64url").toString("utf8"));
  assert.equal(payload.type, "remotedesk-pair");
  assert.equal(payload.url, "https://192.168.1.10:9443");
  assert.deepEqual(payload.invite, invite);
});
