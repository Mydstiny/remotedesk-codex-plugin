import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  writeFile,
  readFile,
  mkdtemp,
  rm,
  chmod,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { isIP } from "node:net";
import { X509Certificate, randomBytes } from "node:crypto";
import { privateDirectory } from "./privacy.mjs";
import { requireThat, string } from "./errors.mjs";
const exec = promisify(execFile);
async function openssl(args) {
  await exec("openssl", args, {
    timeout: 15000,
    maxBuffer: 16384,
    windowsHide: true,
  });
}
export async function initializePki(
  directory,
  hosts = ["localhost", "127.0.0.1"],
) {
  requireThat(hosts.length > 0 && hosts.length <= 10);
  for (const h of hosts) string(h, 253, /^[A-Za-z0-9.:-]+$/);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const caKey = join(directory, "ca.key");
  await openssl([
    "genpkey",
    "-algorithm",
    "RSA",
    "-pkeyopt",
    "rsa_keygen_bits:3072",
    "-out",
    caKey,
  ]);
  await openssl([
    "req",
    "-x509",
    "-new",
    "-key",
    caKey,
    "-sha256",
    "-days",
    "3650",
    "-subj",
    "/CN=RemoteDesk private CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-out",
    join(directory, "ca.pem"),
  ]);
  await openssl([
    "genpkey",
    "-algorithm",
    "RSA",
    "-pkeyopt",
    "rsa_keygen_bits:3072",
    "-out",
    join(directory, "server.key"),
  ]);
  await openssl([
    "req",
    "-new",
    "-key",
    join(directory, "server.key"),
    "-subj",
    "/CN=RemoteDesk",
    "-out",
    join(directory, "server.csr"),
  ]);
  await writeFile(
    join(directory, "server.ext"),
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${hosts.map((h) => `${isIP(h) ? "IP" : "DNS"}:${h}`).join(",")}\n`,
    { mode: 0o600 },
  );
  await sign(
    directory,
    join(directory, "server.csr"),
    join(directory, "server.pem"),
    join(directory, "server.ext"),
    "365",
  );
  if (process.platform !== "win32")
    for (const f of ["ca.key", "server.key"])
      await chmod(join(directory, f), 0o600);
}
async function sign(dir, csr, out, ext, days = "90") {
  await openssl([
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    join(dir, "ca.pem"),
    "-CAkey",
    join(dir, "ca.key"),
    "-set_serial",
    "0x" + randomBytes(16).toString("hex"),
    "-days",
    days,
    "-sha256",
    "-extfile",
    ext,
    "-out",
    out,
  ]);
}
export async function issueClient(directory, csr) {
  string(csr, 16384);
  requireThat(
    /^-----BEGIN CERTIFICATE REQUEST-----\r?\n[\s\S]+-----END CERTIFICATE REQUEST-----\s*$/.test(
      csr,
    ),
  );
  const scratch = await mkdtemp(join(directory, "issue-"));
  try {
    await writeFile(join(scratch, "client.csr"), csr, { mode: 0o600 });
    // Verify CSR proof of possession, never copy requester extensions.
    await openssl([
      "req",
      "-in",
      join(scratch, "client.csr"),
      "-verify",
      "-noout",
    ]);
    await writeFile(
      join(scratch, "client.ext"),
      "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n",
    );
    await sign(
      directory,
      join(scratch, "client.csr"),
      join(scratch, "client.pem"),
      join(scratch, "client.ext"),
    );
    const cert = await readFile(join(scratch, "client.pem"), "utf8");
    const identity = new X509Certificate(cert);
    return {
      cert,
      fingerprint: identity.fingerprint256,
      expires: Date.parse(identity.validTo),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
export async function createClientIdentity(directory) {
  await privateDirectory(directory, { create: true, empty: true });
  await openssl([
    "genpkey",
    "-algorithm",
    "RSA",
    "-pkeyopt",
    "rsa_keygen_bits:3072",
    "-out",
    join(directory, "client.key"),
  ]);
  await openssl([
    "req",
    "-new",
    "-key",
    join(directory, "client.key"),
    "-subj",
    "/CN=RemoteDesk device",
    "-out",
    join(directory, "client.csr"),
  ]);
  if (process.platform !== "win32")
    await chmod(join(directory, "client.key"), 0o600);
  return readFile(join(directory, "client.csr"), "utf8");
}

export async function renewServer(directory) {
  const p = join(directory, "server.pem"),
    csr = join(directory, "server.csr"),
    ext = join(directory, "server.ext");
  const next = join(directory, "server.next.pem");
  await sign(directory, csr, next, ext, "365");
  const certificate = new X509Certificate(await readFile(next));
  requireThat(
    certificate.checkPrivateKey(
      (await import("node:crypto")).createPrivateKey(
        await readFile(join(directory, "server.key")),
      ),
    ),
    "CERTIFICATE_KEY_MISMATCH",
  );
  await rename(next, p);
  return { renewed: true, expires: certificate.validTo, restartRequired: true };
}
