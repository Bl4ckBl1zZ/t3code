import { spawn } from "node:child_process";

const passthroughArgs = process.argv.slice(2);
const shutdownGraceMs = 1_500;
const children = [];
let shuttingDown = false;

function spawnManaged(name, command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
    detached: false,
  });
  children.push({ name, process: child });

  child.once("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    const exitCode = code ?? (signal ? 1 : 0);
    console.error(`[dev-desktop] ${name} exited${signal ? ` via ${signal}` : ` with ${exitCode}`}`);
    void shutdown(exitCode === 0 ? 1 : exitCode);
  });
}

function killChild(child, signal) {
  if (typeof child.pid !== "number" || child.killed) {
    return;
  }
  child.kill(signal);
}

async function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    killChild(child.process, "SIGTERM");
  }
  await new Promise((resolve) => {
    setTimeout(resolve, shutdownGraceMs);
  });
  for (const child of children) {
    killChild(child.process, "SIGKILL");
  }
  process.exit(exitCode);
}

spawnManaged("desktop app", process.execPath, [
  "scripts/dev-runner.ts",
  "dev:desktop",
  ...passthroughArgs,
]);
spawnManaged("server bundle", "vp", ["run", "--filter=t3", "dev:bundle"]);
spawnManaged("browser extension", process.execPath, [
  "scripts/dev-browser-extension-sync.mjs",
  "--watch",
]);

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
