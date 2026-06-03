import {
  OrganizationPanelDynamicRpcMethod,
  OrganizationPanelError,
  type OrganizationId,
  type OrganizationPanelDynamicRpcInvokeResult,
  type OrganizationPanelDynamicRpcListResult,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeVm from "node:vm";

import type { ServerConfigShape } from "./config.ts";
import {
  resolveOrganizationPanelOrganization,
  resolveOrganizationPanelPath,
} from "./organizationPanels.ts";
import { ProcessRunner, type ProcessRunError } from "./processRunner.ts";

type OrganizationPanelSettings = Parameters<
  typeof resolveOrganizationPanelOrganization
>[0] extends {
  readonly settings?: infer Settings;
}
  ? Settings
  : never;

const RPC_DIRECTORY_NAME = "rpc";
const MAX_DYNAMIC_RPC_DEPTH = 4;
const DEFAULT_DYNAMIC_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_DYNAMIC_RPC_MAX_OUTPUT_BYTES = 256_000;
const MAX_DYNAMIC_RPC_TIMEOUT_MS = 120_000;
const MAX_DYNAMIC_RPC_MAX_OUTPUT_BYTES = 2_000_000;

const DynamicRpcParamDefinition = Schema.Struct({
  type: Schema.Literals(["string", "number", "integer", "boolean"]),
  required: Schema.optional(Schema.Boolean),
  pattern: Schema.optional(Schema.String),
  min: Schema.optional(Schema.Number),
  max: Schema.optional(Schema.Number),
});
type DynamicRpcParamDefinition = typeof DynamicRpcParamDefinition.Type;

const DynamicRpcCommandExecutor = Schema.Struct({
  kind: Schema.Literal("command"),
  command: Schema.String.check(Schema.isNonEmpty()),
  args: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({
        minimum: 1_000,
        maximum: MAX_DYNAMIC_RPC_TIMEOUT_MS,
      }),
    ),
  ),
  maxOutputBytes: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({
        minimum: 1_024,
        maximum: MAX_DYNAMIC_RPC_MAX_OUTPUT_BYTES,
      }),
    ),
  ),
  output: Schema.optional(Schema.Literals(["json", "text"])),
});
type DynamicRpcCommandExecutor = typeof DynamicRpcCommandExecutor.Type;

const DynamicRpcCustomExecutor = Schema.Struct({
  kind: Schema.Literal("custom"),
  source: Schema.String.check(Schema.isMaxLength(20_000)),
  timeoutMs: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({
        minimum: 1_000,
        maximum: MAX_DYNAMIC_RPC_TIMEOUT_MS,
      }),
    ),
  ),
});
type DynamicRpcCustomExecutor = typeof DynamicRpcCustomExecutor.Type;

const DynamicRpcManifest = Schema.Struct({
  method: OrganizationPanelDynamicRpcMethod,
  label: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  description: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  inputSchema: Schema.optional(Schema.Unknown),
  params: Schema.optional(Schema.Record(Schema.String, DynamicRpcParamDefinition)),
  executor: Schema.Union([DynamicRpcCommandExecutor, DynamicRpcCustomExecutor]),
});
type DynamicRpcManifest = typeof DynamicRpcManifest.Type;

const decodeDynamicRpcManifestJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DynamicRpcManifest),
);
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

interface DynamicRpcContext {
  readonly config: ServerConfigShape;
  readonly organizationId: OrganizationId;
  readonly settings?: OrganizationPanelSettings | undefined;
  readonly depth: number;
}

export const listOrganizationPanelDynamicRpcMethods = (input: {
  readonly config: ServerConfigShape;
  readonly organizationId: OrganizationId;
  readonly settings?: OrganizationPanelSettings | undefined;
}): Effect.Effect<
  OrganizationPanelDynamicRpcListResult,
  OrganizationPanelError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const manifests = yield* loadDynamicRpcManifests({
      config: input.config,
      organizationId: input.organizationId,
      settings: input.settings,
    });

    return {
      methods: manifests.map(toDynamicRpcMethodSummary),
    };
  });

function toDynamicRpcMethodSummary(manifest: DynamicRpcManifest) {
  const summary: {
    method: OrganizationPanelDynamicRpcListResult["methods"][number]["method"];
    label?: OrganizationPanelDynamicRpcListResult["methods"][number]["label"];
    description?: OrganizationPanelDynamicRpcListResult["methods"][number]["description"];
    inputSchema?: unknown;
  } = {
    method: manifest.method,
  };
  if (manifest.label !== undefined) {
    summary.label = manifest.label;
  }
  if (manifest.description !== undefined) {
    summary.description = manifest.description;
  }
  if (manifest.inputSchema !== undefined) {
    summary.inputSchema = manifest.inputSchema;
  }
  return summary;
}

export const invokeOrganizationPanelDynamicRpcMethod = (input: {
  readonly config: ServerConfigShape;
  readonly organizationId: OrganizationId;
  readonly settings?: OrganizationPanelSettings | undefined;
  readonly method: OrganizationPanelDynamicRpcMethod;
  readonly payload: unknown;
}): Effect.Effect<
  OrganizationPanelDynamicRpcInvokeResult,
  OrganizationPanelError,
  FileSystem.FileSystem | Path.Path | ProcessRunner
> =>
  invokeDynamicRpcMethod({
    config: input.config,
    organizationId: input.organizationId,
    settings: input.settings,
    method: input.method,
    payload: input.payload,
    depth: 0,
  });

const invokeDynamicRpcMethod = (
  input: DynamicRpcContext & {
    readonly method: OrganizationPanelDynamicRpcMethod;
    readonly payload: unknown;
  },
): Effect.Effect<
  OrganizationPanelDynamicRpcInvokeResult,
  OrganizationPanelError,
  FileSystem.FileSystem | Path.Path | ProcessRunner
> =>
  Effect.gen(function* () {
    if (input.depth > MAX_DYNAMIC_RPC_DEPTH) {
      return yield* dynamicRpcError(
        "dynamic-rpc-failed",
        `Dynamic RPC "${input.method}" exceeded the nested invocation limit.`,
      );
    }

    const manifests = yield* loadDynamicRpcManifests(input);
    const manifest = manifests.find((candidate) => candidate.method === input.method);
    if (!manifest) {
      return yield* dynamicRpcError(
        "dynamic-rpc-not-found",
        `Dynamic RPC method "${input.method}" was not found.`,
      );
    }

    const payload = validateDynamicRpcPayload(manifest, input.payload);
    if (payload._tag === "Left") {
      return yield* dynamicRpcError("dynamic-rpc-invalid", payload.left);
    }

    const result =
      manifest.executor.kind === "command"
        ? yield* runCommandExecutor({
            context: input,
            manifest,
            executor: manifest.executor,
            payload: payload.right,
          })
        : yield* runCustomExecutor({
            context: input,
            manifest,
            executor: manifest.executor,
            payload: payload.right,
          });

    return {
      method: input.method,
      result,
    };
  });

const loadDynamicRpcManifests = (input: {
  readonly config: ServerConfigShape;
  readonly organizationId: OrganizationId;
  readonly settings?: OrganizationPanelSettings | undefined;
}): Effect.Effect<
  readonly DynamicRpcManifest[],
  OrganizationPanelError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const organization = resolveOrganizationPanelOrganization({
      organizationId: input.organizationId,
      settings: input.settings,
    });
    if (!organization) {
      return yield* dynamicRpcError(
        "organization-not-found",
        `Organization "${input.organizationId}" was not found.`,
      );
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const panelPath = yield* resolveOrganizationPanelPath({
      storageRoot: input.config.stateDir,
      organizationId: input.organizationId,
      panelSlug: organization.panelSlug,
    });
    const rpcDirectory = path.join(panelPath.folderAbsolutePath, RPC_DIRECTORY_NAME);
    const exists = yield* fs.exists(rpcDirectory).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return [];
    }

    const entries = yield* fs.readDirectory(rpcDirectory).pipe(
      Effect.mapError(
        (cause) =>
          new OrganizationPanelError({
            code: "dynamic-rpc-invalid",
            message: "Failed to read organization panel dynamic RPC directory.",
            cause,
          }),
      ),
    );
    const manifests: DynamicRpcManifest[] = [];

    for (const entry of entries.toSorted()) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const manifestPath = path.join(rpcDirectory, entry);
      const raw = yield* fs.readFileString(manifestPath).pipe(
        Effect.mapError(
          (cause) =>
            new OrganizationPanelError({
              code: "dynamic-rpc-invalid",
              message: `Failed to read dynamic RPC manifest "${entry}".`,
              cause,
            }),
        ),
      );
      const manifest = yield* decodeDynamicRpcManifestJson(raw).pipe(
        Effect.mapError(
          (cause) =>
            new OrganizationPanelError({
              code: "dynamic-rpc-invalid",
              message: `Dynamic RPC manifest "${entry}" is invalid: ${cause.message}`,
              cause,
            }),
        ),
      );
      const manifestError = validateDynamicRpcManifest(manifest, entry);
      if (manifestError) {
        return yield* dynamicRpcError("dynamic-rpc-invalid", manifestError);
      }
      manifests.push(manifest);
    }

    return manifests;
  });

function validateDynamicRpcManifest(manifest: DynamicRpcManifest, fileName: string): string | null {
  if (
    manifest.executor.kind === "command" &&
    !/^[A-Za-z0-9._+-]+$/u.test(manifest.executor.command)
  ) {
    return `Dynamic RPC manifest "${fileName}" uses an invalid command name.`;
  }
  return null;
}

function validateDynamicRpcPayload(
  manifest: DynamicRpcManifest,
  payload: unknown,
):
  | { readonly _tag: "Left"; readonly left: string }
  | { readonly _tag: "Right"; readonly right: Record<string, unknown> } {
  if (!isRecord(payload)) {
    return { _tag: "Left", left: `Dynamic RPC "${manifest.method}" payload must be an object.` };
  }

  const params = manifest.params ?? {};
  for (const [name, definition] of Object.entries(params)) {
    const value = payload[name];
    if (value === undefined) {
      if (definition.required === true) {
        return {
          _tag: "Left",
          left: `Dynamic RPC "${manifest.method}" requires parameter "${name}".`,
        };
      }
      continue;
    }

    const invalid = invalidParamReason(name, value, definition);
    if (invalid) {
      return { _tag: "Left", left: invalid };
    }
  }

  return { _tag: "Right", right: payload };
}

function invalidParamReason(
  name: string,
  value: unknown,
  definition: DynamicRpcParamDefinition,
): string | null {
  switch (definition.type) {
    case "string":
      if (typeof value !== "string") return `Parameter "${name}" must be a string.`;
      if (definition.pattern !== undefined && !new RegExp(definition.pattern, "u").test(value)) {
        return `Parameter "${name}" does not match its required pattern.`;
      }
      return null;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `Parameter "${name}" must be a finite number.`;
      }
      return invalidNumberRangeReason(name, value, definition);
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `Parameter "${name}" must be an integer.`;
      }
      return invalidNumberRangeReason(name, value, definition);
    case "boolean":
      return typeof value === "boolean" ? null : `Parameter "${name}" must be a boolean.`;
  }
}

function invalidNumberRangeReason(
  name: string,
  value: number,
  definition: DynamicRpcParamDefinition,
): string | null {
  if (definition.min !== undefined && value < definition.min) {
    return `Parameter "${name}" must be at least ${definition.min}.`;
  }
  if (definition.max !== undefined && value > definition.max) {
    return `Parameter "${name}" must be at most ${definition.max}.`;
  }
  return null;
}

const runCommandExecutor = (input: {
  readonly context: DynamicRpcContext;
  readonly manifest: DynamicRpcManifest;
  readonly executor: DynamicRpcCommandExecutor;
  readonly payload: Record<string, unknown>;
}): Effect.Effect<
  unknown,
  OrganizationPanelError,
  FileSystem.FileSystem | Path.Path | ProcessRunner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processRunner = yield* ProcessRunner;
    const organization = resolveOrganizationPanelOrganization({
      organizationId: input.context.organizationId,
      settings: input.context.settings,
    });
    if (!organization) {
      return yield* dynamicRpcError(
        "organization-not-found",
        `Organization "${input.context.organizationId}" was not found.`,
      );
    }
    const panelPath = yield* resolveOrganizationPanelPath({
      storageRoot: input.context.config.stateDir,
      organizationId: input.context.organizationId,
      panelSlug: organization.panelSlug,
    });
    const cwd = input.executor.cwd
      ? resolveRelativeCwd(path, panelPath.folderAbsolutePath, input.executor.cwd)
      : panelPath.folderAbsolutePath;
    if (cwd === null || !(yield* fs.exists(cwd).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* dynamicRpcError(
        "dynamic-rpc-invalid",
        `Dynamic RPC "${input.manifest.method}" resolved to an invalid cwd.`,
      );
    }

    const args = input.executor.args.map((arg) => renderTemplate(arg, input.payload));
    if (args.some((arg) => arg === null)) {
      return yield* dynamicRpcError(
        "dynamic-rpc-invalid",
        `Dynamic RPC "${input.manifest.method}" references a missing or non-scalar parameter.`,
      );
    }

    const output = yield* processRunner
      .run({
        command: input.executor.command,
        args: args as string[],
        cwd,
        timeout: Duration.millis(input.executor.timeoutMs ?? DEFAULT_DYNAMIC_RPC_TIMEOUT_MS),
        maxOutputBytes: input.executor.maxOutputBytes ?? DEFAULT_DYNAMIC_RPC_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        truncatedMarker: "\n[output truncated]\n",
        shell: false,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.mapError((cause) => toDynamicRpcProcessError(input.manifest.method, cause)));

    if (output.timedOut) {
      return yield* dynamicRpcError(
        "dynamic-rpc-failed",
        `Dynamic RPC "${input.manifest.method}" timed out.`,
      );
    }
    if (Number(output.code ?? 0) !== 0) {
      return yield* dynamicRpcError(
        "dynamic-rpc-failed",
        `Dynamic RPC "${input.manifest.method}" failed with exit code ${Number(output.code)}: ${output.stderr.trim()}`,
      );
    }

    if ((input.executor.output ?? "json") === "text") {
      return {
        stdout: output.stdout,
        stderr: output.stderr,
        stdoutTruncated: output.stdoutTruncated,
        stderrTruncated: output.stderrTruncated,
      };
    }

    return yield* decodeUnknownJson(output.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new OrganizationPanelError({
            code: "dynamic-rpc-failed",
            message: `Dynamic RPC "${input.manifest.method}" returned invalid JSON: ${cause.message}`,
            cause,
          }),
      ),
    );
  });

const runCustomExecutor = (input: {
  readonly context: DynamicRpcContext;
  readonly manifest: DynamicRpcManifest;
  readonly executor: DynamicRpcCustomExecutor;
  readonly payload: Record<string, unknown>;
}): Effect.Effect<
  unknown,
  OrganizationPanelError,
  FileSystem.FileSystem | Path.Path | ProcessRunner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processRunner = yield* ProcessRunner;
    const timeoutMs = input.executor.timeoutMs ?? DEFAULT_DYNAMIC_RPC_TIMEOUT_MS;
    const nestedContext = {
      config: input.context.config,
      organizationId: input.context.organizationId,
      settings: input.context.settings,
      depth: input.context.depth + 1,
    } satisfies DynamicRpcContext;

    const customEffect = Effect.tryPromise({
      try: () => {
        const script = new NodeVm.Script(
          `(async (input, ctx) => {
            "use strict";
            ${input.executor.source}
          })`,
          {
            filename: `${input.manifest.method}.js`,
          },
        );
        const sandbox = NodeVm.createContext(Object.freeze({}));
        const handler = script.runInContext(sandbox, { timeout: timeoutMs }) as (
          payload: Record<string, unknown>,
          context: {
            readonly rpc: (method: string, payload: Record<string, unknown>) => Promise<unknown>;
            readonly log: (...args: readonly unknown[]) => void;
          },
        ) => Promise<unknown>;

        return handler(input.payload, {
          rpc: async (method, payload) => {
            const parsedMethod = OrganizationPanelDynamicRpcMethod.make(method);
            const result = await Effect.runPromise(
              invokeDynamicRpcMethod({
                ...nestedContext,
                method: parsedMethod,
                payload,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.provideService(ProcessRunner, processRunner),
              ),
            );
            return result.result;
          },
          log: () => {},
        });
      },
      catch: (cause) =>
        new OrganizationPanelError({
          code: "dynamic-rpc-failed",
          message:
            cause instanceof Error
              ? cause.message
              : `Dynamic RPC "${input.manifest.method}" custom executor failed.`,
          cause,
        }),
    }).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)));

    const result = yield* customEffect;
    return yield* Option.match(result, {
      onNone: () =>
        dynamicRpcError("dynamic-rpc-failed", `Dynamic RPC "${input.manifest.method}" timed out.`),
      onSome: Effect.succeed,
    });
  });

function renderTemplate(template: string, payload: Record<string, unknown>): string | null {
  let failed = false;
  const rendered = template.replace(/\$\{([A-Za-z0-9_.-]+)\}/gu, (_match, key: string) => {
    const value = payload[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    failed = true;
    return "";
  });
  return failed ? null : rendered;
}

function resolveRelativeCwd(path: Path.Path, root: string, relativeCwd: string): string | null {
  if (relativeCwd.startsWith("/") || relativeCwd.includes("\0")) {
    return null;
  }
  const resolved = path.resolve(root, relativeCwd);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toDynamicRpcProcessError(
  method: OrganizationPanelDynamicRpcMethod,
  cause: ProcessRunError,
): OrganizationPanelError {
  return new OrganizationPanelError({
    code: "dynamic-rpc-failed",
    message: `Dynamic RPC "${method}" failed to run process.`,
    cause,
  });
}

function dynamicRpcError(
  code: OrganizationPanelError["code"],
  message: string,
): Effect.Effect<never, OrganizationPanelError> {
  return Effect.fail(
    new OrganizationPanelError({
      code,
      message,
    }),
  );
}
