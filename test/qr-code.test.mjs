import { test } from "node:test";
import assert from "node:assert/strict";
import { invitePairingLink, inviteQrDataUrl } from "../src/qr-code.mjs";

test("pairing QR and link carry the exact invite fields", () => {
  const invite = {
    code: "invite-code-0123456789",
    expires: Date.now() + 120000,
    ca: "-----BEGIN CERTIFICATE-----\\n" + "A".repeat(1440) + "\\n-----END CERTIFICATE-----\\n",
    serverInstance: "server-instance-0123456789",
  };
  const qr = inviteQrDataUrl(invite);
  assert.match(qr, /^data:image\/svg\+xml;base64,/);
  const link = invitePairingLink(invite, { host: "192.168.1.10", port: 9443 }, "codex");
  assert.match(link, /^remotedesk:\/\/pair\?data=/);
  const payload = JSON.parse(Buffer.from(link.split("data=")[1], "base64url").toString("utf8"));
  assert.equal(payload.type, "remotedesk-pair");
  assert.equal(payload.url, "https://192.168.1.10:9443");
  assert.deepEqual(payload.invite, invite);
});
