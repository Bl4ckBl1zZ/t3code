import { watch } from "node:fs";
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEV_RELOAD_MANIFEST_FILE = "dev-reload.json";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultSourceDir = path.join(repoRoot, "apps", "chrome-extension");
const defaultUserDataDirNames = ["t3code-dev", "t3code"];
const debounceMs = 120;

function resolveAppDataDirectory(input) {
  const platform = input.platform ?? process.platform;
  const homeDirectory = input.homeDirectory ?? homedir();
  if (input.appDataDirectory) {
    return input.appDataDirectory;
  }
  if (platform === "win32") {
    return process.env.APPDATA ?? path.join(homeDirectory, "AppData", "Roaming");
  }
  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(homeDirectory, ".config");
}

export function resolveDefaultBrowserExtensionInstallDirs(input = {}) {
  const appDataDirectory = resolveAppDataDirectory(input);
  return defaultUserDataDirNames.map((dirName) =>
    path.join(appDataDirectory, dirName, "Chrome Extension"),
  );
}

function makeReloadToken(now) {
  return `${now.getTime()}-${Math.random().toString(36).slice(2)}`;
}

export function makeDevReloadManifest(input) {
  const now = input?.now ?? new Date();
  return {
    enabled: true,
    token: input?.token ?? makeReloadToken(now),
    updatedAt: now.toISOString(),
  };
}

export async function syncBrowserExtensionInstall(input) {
  const sourceInfo = await stat(input.sourceDir);
  if (!sourceInfo.isDirectory()) {
    throw new Error(`Browser extension source is not a directory: ${input.sourceDir}`);
  }

  const synced = [];
  const now = input.now ?? new Date();
  const manifest = makeDevReloadManifest({
    ...(input.token !== undefined ? { token: input.token } : {}),
    now,
  });
  for (const [index, destinationDir] of input.destinationDirs.entries()) {
    const tempDir = path.join(
      tmpdir(),
      `t3code-browser-extension-${process.pid}-${now.getTime()}-${index}`,
    );
    await rm(tempDir, { recursive: true, force: true });
    try {
      await cp(input.sourceDir, tempDir, {
        recursive: true,
        force: true,
        dereference: false,
      });
      await writeFile(
        path.join(tempDir, DEV_RELOAD_MANIFEST_FILE),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await mkdir(path.dirname(destinationDir), { recursive: true });
      await rm(destinationDir, { recursive: true, force: true });
      await rename(tempDir, destinationDir);
      synced.push(destinationDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return synced;
}

async function fingerprintDirectory(directory) {
  const entries = [];

  async function visit(currentDir, relativePrefix) {
    const dirents = await readdir(currentDir, { withFileTypes: true });
    for (const dirent of dirents) {
      const absolutePath = path.join(currentDir, dirent.name);
      const relativePath = path.join(relativePrefix, dirent.name);
      const info = await stat(absolutePath);
      entries.push(
        `${relativePath}:${info.mtimeMs}:${info.size}:${dirent.isDirectory() ? "d" : "f"}`,
      );
      if (dirent.isDirectory()) {
        await visit(absolutePath, relativePath);
      }
    }
  }

  await visit(directory, "");
  return entries.sort().join("\n");
}

function parseCliOptions(argv) {
  let watchMode = false;
  let sourceDir = defaultSourceDir;
  const destinationDirs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--watch") {
      watchMode = true;
      continue;
    }
    if (arg === "--source-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--source-dir requires a path.");
      sourceDir = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--install-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--install-dir requires a path.");
      destinationDirs.push(path.resolve(value));
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    watch: watchMode,
    sourceDir,
    destinationDirs:
      destinationDirs.length > 0 ? destinationDirs : resolveDefaultBrowserExtensionInstallDirs(),
  };
}

async function syncAndLog(options) {
  const synced = await syncBrowserExtensionInstall({
    sourceDir: options.sourceDir,
    destinationDirs: options.destinationDirs,
  });
  console.log(
    `[dev-extension-sync] synced ${path.relative(repoRoot, options.sourceDir)} -> ${synced.join(", ")}`,
  );
}

function watchRecursive(directory, onChange) {
  try {
    const watcher = watch(directory, { recursive: true }, () => onChange());
    return watcher;
  } catch {
    return null;
  }
}

async function watchByPolling(directory, onChange) {
  let previousFingerprint = await fingerprintDirectory(directory);
  const interval = setInterval(() => {
    void fingerprintDirectory(directory)
      .then((fingerprint) => {
        if (fingerprint !== previousFingerprint) {
          previousFingerprint = fingerprint;
          onChange();
        }
      })
      .catch((error) => {
        console.warn("[dev-extension-sync] failed to scan extension source", error);
      });
  }, 1_000);
  return {
    close: () => clearInterval(interval),
  };
}

async function runWatchMode(options) {
  let timer = null;
  let syncQueue = Promise.resolve();
  const scheduleSync = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      syncQueue = syncQueue
        .catch(() => undefined)
        .then(() => syncAndLog(options))
        .catch((error) => {
          console.error("[dev-extension-sync] sync failed", error);
        });
    }, debounceMs);
  };

  await syncAndLog(options);
  const watcher =
    watchRecursive(options.sourceDir, scheduleSync) ??
    (await watchByPolling(options.sourceDir, scheduleSync));
  console.log("[dev-extension-sync] watching browser extension source");

  await new Promise((resolve) => {
    const shutdown = () => {
      if (timer) {
        clearTimeout(timer);
      }
      watcher.close();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

export async function runBrowserExtensionSyncCli(argv = process.argv.slice(2)) {
  const options = parseCliOptions(argv);
  if (options.watch) {
    await runWatchMode(options);
    return;
  }
  await syncAndLog(options);
}

if (import.meta.main) {
  runBrowserExtensionSyncCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
