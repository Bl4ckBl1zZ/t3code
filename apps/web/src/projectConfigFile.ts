import {
  PROJECT_CONFIG_RELATIVE_PATH,
  PROJECT_CONFIG_SCHEMA_URL,
  type EnvironmentApi,
  type ProjectScript,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import { setupProjectScript } from "@t3tools/shared/projectScripts";

import { nextProjectScriptId } from "./projectScripts";

type ProjectConfigJson = Record<string, unknown>;

const WORKTREE_SETUP_SCRIPT_NAME = "Worktree setup";
const WORKTREE_SETUP_SCRIPT_ICON: ProjectScript["icon"] = "configure";

function asRecord(value: unknown): ProjectConfigJson | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as ProjectConfigJson;
}

function pruneEmptyObjectProperty(config: ProjectConfigJson, key: string): void {
  const value = asRecord(config[key]);
  if (value && Object.keys(value).length === 0) {
    delete config[key];
  }
}

export function parseProjectConfigContents(contents: string | null): ProjectConfigJson {
  const trimmed = contents?.trim() ?? "";
  if (trimmed.length === 0) {
    return {};
  }

  const parsed = JSON.parse(trimmed) as unknown;
  const config = asRecord(parsed);
  if (!config) {
    throw new Error("Project config must be a JSON object.");
  }
  return { ...config };
}

export async function readProjectConfigFile(
  api: EnvironmentApi,
  cwd: string,
): Promise<ProjectConfigJson> {
  const existing = await api.projects.readFile({
    cwd,
    relativePath: PROJECT_CONFIG_RELATIVE_PATH,
  });
  return parseProjectConfigContents(existing.contents);
}

export async function updateProjectConfigFile(input: {
  readonly api: EnvironmentApi;
  readonly cwd: string;
  readonly update: (config: ProjectConfigJson) => void;
}): Promise<ProjectConfigJson> {
  const config = await readProjectConfigFile(input.api, input.cwd);
  config.$schema = typeof config.$schema === "string" ? config.$schema : PROJECT_CONFIG_SCHEMA_URL;
  input.update(config);

  await input.api.projects.writeFile({
    cwd: input.cwd,
    relativePath: PROJECT_CONFIG_RELATIVE_PATH,
    contents: `${JSON.stringify(config, null, 2)}\n`,
  });

  return config;
}

export function getProjectConfigNewThreadEnvMode(config: ProjectConfigJson): ThreadEnvMode | null {
  const thread = asRecord(config.thread);
  const value = thread?.newThreadEnvMode;
  return value === "local" || value === "worktree" ? value : null;
}

export function setProjectConfigNewThreadEnvMode(
  config: ProjectConfigJson,
  envMode: ThreadEnvMode | null,
): void {
  const thread = { ...asRecord(config.thread) };
  if (envMode === null) {
    delete thread.newThreadEnvMode;
  } else {
    thread.newThreadEnvMode = envMode;
  }
  config.thread = thread;
  pruneEmptyObjectProperty(config, "thread");
}

export function getProjectConfigBrowserPreviewUrl(config: ProjectConfigJson): string {
  const browser = asRecord(config.browser);
  const value = browser?.previewUrl;
  return typeof value === "string" ? value : "";
}

export function setProjectConfigBrowserPreviewUrl(config: ProjectConfigJson, previewUrl: string) {
  const trimmed = previewUrl.trim();
  const browser = { ...asRecord(config.browser) };
  if (trimmed.length === 0) {
    delete browser.previewUrl;
  } else {
    browser.previewUrl = trimmed;
  }
  config.browser = browser;
  pruneEmptyObjectProperty(config, "browser");
}

export function getWorktreeSetupCommand(scripts: readonly ProjectScript[]): string {
  return setupProjectScript(scripts)?.command ?? "";
}

export function buildScriptsWithWorktreeSetupCommand(
  scripts: readonly ProjectScript[],
  command: string,
): ProjectScript[] {
  const trimmed = command.trim();
  const setupScript = setupProjectScript(scripts);

  if (trimmed.length === 0) {
    return scripts.filter((script) => !script.runOnWorktreeCreate);
  }

  const nextSetupScript: ProjectScript = setupScript
    ? {
        ...setupScript,
        command: trimmed,
        runOnWorktreeCreate: true,
      }
    : {
        id: nextProjectScriptId(
          WORKTREE_SETUP_SCRIPT_NAME,
          scripts.map((script) => script.id),
        ),
        name: WORKTREE_SETUP_SCRIPT_NAME,
        command: trimmed,
        icon: WORKTREE_SETUP_SCRIPT_ICON,
        runOnWorktreeCreate: true,
      };

  let foundSetupScript = false;
  const nextScripts = scripts.map((script) => {
    if (setupScript && script.id === setupScript.id) {
      foundSetupScript = true;
      return nextSetupScript;
    }
    return script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script;
  });

  if (!foundSetupScript) {
    nextScripts.push(nextSetupScript);
  }

  return nextScripts;
}

export async function writeProjectConfigScripts(input: {
  readonly api: EnvironmentApi;
  readonly projectCwd: string;
  readonly scripts: ProjectScript[];
  readonly browserPreviewUrl: string | null | undefined;
}): Promise<void> {
  await updateProjectConfigFile({
    api: input.api,
    cwd: input.projectCwd,
    update: (config) => {
      if (
        !("browser" in config) &&
        input.browserPreviewUrl !== undefined &&
        input.browserPreviewUrl !== null &&
        input.browserPreviewUrl.trim().length > 0
      ) {
        setProjectConfigBrowserPreviewUrl(config, input.browserPreviewUrl);
      }
      config.scripts = input.scripts;
    },
  });
}
