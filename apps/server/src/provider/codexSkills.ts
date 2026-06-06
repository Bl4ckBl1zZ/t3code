import {
  CodexSettings,
  ProviderInstanceId,
  ServerSkillManagementError,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import {
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
  type CodexHomeLayout,
} from "./Drivers/CodexHomeLayout.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

interface ResolvedCodexSkillInstance {
  readonly codexSettings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly homeLayout: CodexHomeLayout;
}

function toSkillError(input: {
  readonly instanceId: ProviderInstanceId;
  readonly detail: string;
  readonly cause?: unknown;
}) {
  return new ServerSkillManagementError({
    instanceId: input.instanceId,
    detail: input.detail,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

function titleCaseSkillName(name: string): string {
  return name
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function buildSkillMarkdown(input: {
  readonly name: string;
  readonly displayName?: string | undefined;
  readonly description: string;
  readonly shortDescription?: string | undefined;
  readonly body: string;
}): string {
  const title = input.displayName?.trim() || titleCaseSkillName(input.name);
  const shortDescription = input.shortDescription?.trim();
  const frontmatter = [
    "---",
    `name: ${quoteYamlString(input.name)}`,
    `description: ${quoteYamlString(input.description)}`,
    ...(shortDescription
      ? ["metadata:", `  short-description: ${quoteYamlString(shortDescription)}`]
      : []),
    "---",
  ].join("\n");
  const body = input.body.trim() || "Add the workflow, constraints, and examples for this skill.";
  return `${frontmatter}\n\n# ${title}\n\n${body}\n`;
}

export const resolveCodexSkillInstance = Effect.fn("resolveCodexSkillInstance")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ServerSettings;
}): Effect.fn.Return<ResolvedCodexSkillInstance, ServerSkillManagementError, Path.Path> {
  const explicitInstance = input.settings.providerInstances[input.instanceId];
  const rawConfig =
    explicitInstance?.driver === "codex" ? explicitInstance.config : input.settings.providers.codex;

  if (explicitInstance !== undefined && explicitInstance.driver !== "codex") {
    return yield* toSkillError({
      instanceId: input.instanceId,
      detail: "Only Codex provider instances support skill management.",
    });
  }
  if (explicitInstance === undefined && input.instanceId !== ProviderInstanceId.make("codex")) {
    return yield* toSkillError({
      instanceId: input.instanceId,
      detail: "The selected provider instance is not configured.",
    });
  }

  const codexSettings = yield* Effect.try({
    try: () => decodeCodexSettings(rawConfig ?? {}),
    catch: (cause) =>
      toSkillError({
        instanceId: input.instanceId,
        detail: "Could not decode Codex provider settings.",
        cause,
      }),
  });
  const homeLayout = yield* resolveCodexHomeLayout(codexSettings).pipe(
    Effect.mapError((cause) =>
      toSkillError({
        instanceId: input.instanceId,
        detail: "Could not resolve Codex home path.",
        cause,
      }),
    ),
  );

  return {
    codexSettings,
    environment: mergeProviderInstanceEnvironment(explicitInstance?.environment),
    homeLayout,
  };
});

const resolveManagedSkillFile = Effect.fn("resolveManagedSkillFile")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly homeLayout: CodexHomeLayout;
  readonly skillPath: string;
}): Effect.fn.Return<
  { readonly skillsRoot: string; readonly skillDirectory: string; readonly skillFile: string },
  ServerSkillManagementError,
  Path.Path
> {
  const path = yield* Path.Path;
  const skillsRoot = path.resolve(path.join(input.homeLayout.sharedHomePath, "skills"));
  const skillFile = path.resolve(input.skillPath);
  const skillDirectory = path.dirname(skillFile);

  if (path.basename(skillFile) !== "SKILL.md" || path.dirname(skillDirectory) !== skillsRoot) {
    return yield* toSkillError({
      instanceId: input.instanceId,
      detail: "Only user skills in the configured CODEX_HOME skills directory can be managed.",
    });
  }

  return { skillsRoot, skillDirectory, skillFile };
});

export const upsertCodexSkill = Effect.fn("upsertCodexSkill")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ServerSettings;
  readonly name: string;
  readonly displayName?: string | undefined;
  readonly description: string;
  readonly shortDescription?: string | undefined;
  readonly body: string;
  readonly overwrite: boolean;
}): Effect.fn.Return<void, ServerSkillManagementError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const instance = yield* resolveCodexSkillInstance({
    instanceId: input.instanceId,
    settings: input.settings,
  });
  const skillsRoot = path.join(instance.homeLayout.sharedHomePath, "skills");
  const skillDirectory = path.join(skillsRoot, input.name);
  const skillFile = path.join(skillDirectory, "SKILL.md");
  const exists = yield* fileSystem.exists(skillFile).pipe(Effect.orElseSucceed(() => false));

  if (exists && !input.overwrite) {
    return yield* toSkillError({
      instanceId: input.instanceId,
      detail: `Skill '${input.name}' already exists.`,
    });
  }

  yield* fileSystem.makeDirectory(skillDirectory, { recursive: true }).pipe(
    Effect.mapError((cause) =>
      toSkillError({
        instanceId: input.instanceId,
        detail: "Could not create the skill directory.",
        cause,
      }),
    ),
  );
  yield* fileSystem
    .writeFileString(
      skillFile,
      buildSkillMarkdown({
        name: input.name,
        displayName: input.displayName,
        description: input.description,
        shortDescription: input.shortDescription,
        body: input.body,
      }),
    )
    .pipe(
      Effect.mapError((cause) =>
        toSkillError({
          instanceId: input.instanceId,
          detail: "Could not write SKILL.md.",
          cause,
        }),
      ),
    );
});

export const readCodexSkill = Effect.fn("readCodexSkill")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ServerSettings;
  readonly path: string;
}): Effect.fn.Return<string, ServerSkillManagementError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const instance = yield* resolveCodexSkillInstance({
    instanceId: input.instanceId,
    settings: input.settings,
  });
  const skillFile = yield* resolveManagedSkillFile({
    instanceId: input.instanceId,
    homeLayout: instance.homeLayout,
    skillPath: input.path,
  });

  return yield* fileSystem.readFileString(skillFile.skillFile).pipe(
    Effect.mapError((cause) =>
      toSkillError({
        instanceId: input.instanceId,
        detail: "Could not read SKILL.md.",
        cause,
      }),
    ),
  );
});

export const setCodexSkillEnabled = Effect.fn("setCodexSkillEnabled")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ServerSettings;
  readonly cwd: string;
  readonly path: string;
  readonly enabled: boolean;
}): Effect.fn.Return<
  void,
  ServerSkillManagementError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const instance = yield* resolveCodexSkillInstance({
    instanceId: input.instanceId,
    settings: input.settings,
  });
  yield* materializeCodexShadowHome(instance.homeLayout).pipe(
    Effect.mapError((cause) =>
      toSkillError({
        instanceId: input.instanceId,
        detail: cause.message,
        cause,
      }),
    ),
  );

  yield* Effect.scoped(
    Effect.gen(function* () {
      const clientContext = yield* Layer.build(
        CodexClient.layerCommand({
          command: instance.codexSettings.binaryPath,
          args: ["app-server"],
          cwd: input.cwd,
          env: {
            ...instance.environment,
            ...(instance.homeLayout.effectiveHomePath
              ? { CODEX_HOME: instance.homeLayout.effectiveHomePath }
              : {}),
          },
        }),
      );
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(clientContext),
      );

      yield* client.request("initialize", {
        clientInfo: {
          name: "t3code_desktop",
          title: "T3 Code Desktop",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      yield* client.notify("initialized", undefined);
      yield* client.request("skills/config/write", {
        path: input.path,
        enabled: input.enabled,
      });
    }).pipe(
      Effect.mapError((cause) =>
        toSkillError({
          instanceId: input.instanceId,
          detail: "Could not update the skill enabled state.",
          cause,
        }),
      ),
    ),
  );
});

export const deleteCodexSkill = Effect.fn("deleteCodexSkill")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ServerSettings;
  readonly path: string;
}): Effect.fn.Return<void, ServerSkillManagementError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const instance = yield* resolveCodexSkillInstance({
    instanceId: input.instanceId,
    settings: input.settings,
  });
  const skillFile = yield* resolveManagedSkillFile({
    instanceId: input.instanceId,
    homeLayout: instance.homeLayout,
    skillPath: input.path,
  });

  yield* fileSystem.remove(skillFile.skillDirectory, { recursive: true }).pipe(
    Effect.mapError((cause) =>
      toSkillError({
        instanceId: input.instanceId,
        detail: "Could not delete the skill directory.",
        cause,
      }),
    ),
  );
});
