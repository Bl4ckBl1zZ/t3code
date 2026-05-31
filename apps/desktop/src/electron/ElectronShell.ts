import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as Electron from "electron";

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ? Option.some(url.href) : Option.none();
  } catch {
    return Option.none();
  }
}

export interface ElectronShellShape {
  readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
  readonly openInChrome: (
    rawUrl: unknown,
  ) => Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner>;
  readonly copyText: (text: string) => Effect.Effect<void>;
}

export class ElectronShell extends Context.Service<ElectronShell, ElectronShellShape>()(
  "@t3tools/desktop/electron/ElectronShell",
) {}

function encodeUtf16LeBase64(value: string): string {
  return Buffer.from(value, "utf16le").toString("base64");
}

function escapePowerShellStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

interface ChromeLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.CommandOptions;
}

const CHROME_LAUNCH_OPTIONS = {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
} as const satisfies ChildProcess.CommandOptions;

function resolveChromeLaunch(url: string): ChromeLaunch {
  if (process.platform === "darwin") {
    return {
      command: "open",
      args: ["-a", "Google Chrome", url],
      options: CHROME_LAUNCH_OPTIONS,
    };
  }

  if (process.platform === "win32") {
    const encodedCommand = encodeUtf16LeBase64(
      `Start-Process chrome -ArgumentList '${escapePowerShellStringLiteral(url)}'`,
    );
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedCommand,
      ],
      options: CHROME_LAUNCH_OPTIONS,
    };
  }

  return {
    command: "sh",
    args: [
      "-lc",
      'google-chrome "$1" || google-chrome-stable "$1" || chromium "$1" || chromium-browser "$1" || xdg-open "$1"',
      "t3code-open-chrome",
      url,
    ],
    options: CHROME_LAUNCH_OPTIONS,
  };
}

const launchChromeUrl = Effect.fn("desktop.electron.shell.launchChromeUrl")(function* (
  url: string,
): Effect.fn.Return<boolean, never, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const launch = resolveChromeLaunch(url);
  const command = ChildProcess.make(launch.command, launch.args, launch.options);

  return yield* spawner.spawn(command).pipe(
    Effect.flatMap((handle) => handle.exitCode),
    Effect.map((exitCode) => Number(exitCode) === 0),
    Effect.scoped,
    Effect.catch(() => Effect.succeed(false)),
  );
});

const make = ElectronShell.of({
  openExternal: (rawUrl) =>
    Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        Effect.promise(() =>
          Electron.shell.openExternal(externalUrl).then(
            () => true,
            () => false,
          ),
        ),
    }),
  openInChrome: (rawUrl) =>
    Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        launchChromeUrl(externalUrl).pipe(
          Effect.flatMap((launched) =>
            launched
              ? Effect.succeed(true)
              : Effect.promise(() =>
                  Electron.shell.openExternal(externalUrl).then(
                    () => true,
                    () => false,
                  ),
                ),
          ),
        ),
    }),
  copyText: (text) =>
    Effect.sync(() => {
      Electron.clipboard.writeText(text);
    }),
});

export const layer = Layer.succeed(ElectronShell, make);
