import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
const mode = process.argv[2];
const send = (data) => process.stdout.write(JSON.stringify(data) + "\n");
let first;
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (!request.method) {
    send({ id: first.id, result: request.error?.code });
    return;
  }
  if (mode === "hang") return;
  if (mode === "escaped") {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: ["ignore", process.stdout, "ignore"],
    });
    setTimeout(() => send({ id: request.id, result: child.pid }), 100);
    return;
  }
  if (mode === "descendant") {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM',()=>{}); process.stdout.write('ready\\n'); setInterval(()=>{},1000)",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    child.stdout.once("data", () => {
      // Transfer a duplicate pipe into another child that ignores SIGTERM.
      const inherited = spawn(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
        { stdio: ["ignore", process.stdout, "ignore"] },
      );
      setTimeout(
        () => send({ id: request.id, result: [child.pid, inherited.pid] }),
        100,
      );
    });
    return;
  }
  if (mode === "exit") return process.exit(0);
  if (mode === "oversize") return process.stdout.write("x".repeat(5000));
  if (mode === "invalid") return process.stdout.write("bad-json\n");
  if (mode === "unknown") return send({ id: 99999, result: {} });
  if (mode === "approval") {
    first = request;
    send({
      id: "approval1",
      method: "item/commandExecution/requestApproval",
      params: {},
    });
    return;
  }
  if (mode === "error")
    return send({
      id: request.id,
      error: { message: "SECRET_SENTINEL", code: 7 },
    });
  if (mode === "reverse") {
    if (!first) first = request;
    else {
      send({ id: request.id, result: request.method });
      send({ id: first.id, result: first.method });
    }
    return;
  }
  const encoded = Buffer.from(
    JSON.stringify({ id: request.id, result: "中文🙂" }) + "\n",
  );
  for (let i = 0; i < encoded.length; i++)
    process.stdout.write(encoded.subarray(i, i + 1));
});
