import {
  PROJECT_CONFIG_RELATIVE_PATH,
  PROJECT_CONFIG_SCHEMA_URL,
  type EnvironmentApi,
  type ProjectScript,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import { setupProjectScript } from "@t3tools/shared/projectScripts";

import { normalizeBrowserAgentPreviewUrl } from "./browserAgents";
import { nextProjectScriptId } from "./projectScripts";

type ProjectConfigJson = Record<string, unknown>;

export interface ProjectConfigFileUpdate {
  readonly scripts?: readonly ProjectScript[] | undefined;
  readonly browserPreviewUrl?: string | null | undefined;
}

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

export function parseProjectConfigContents(contents: string | null | undefined): ProjectConfigJson {
  const trimmed = contents?.trim() ?? "";
  if (trimmed.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const config = asRecord(parsed);
    if (!config) {
      throw new Error("Project config must be a JSON object.");
    }
    return { ...config };
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Invalid ${PROJECT_CONFIG_RELATIVE_PATH}: ${error.message}`
        : `Invalid ${PROJECT_CONFIG_RELATIVE_PATH}.`,
      { cause: error },
    );
  }
}

function normalizedPreviewUrl(rawUrl: string | null): string | null {
  if (rawUrl === null) {
    return null;
  }
  const normalized = normalizeBrowserAgentPreviewUrl(rawUrl);
  return normalized.length > 0 ? normalized : null;
}

function applyBrowserPreviewUrl(config: ProjectConfigJson, rawUrl: string | null): void {
  const previewUrl = normalizedPreviewUrl(rawUrl);
  const browser = { ...asRecord(config.browser) };

  if (previewUrl === null) {
    delete browser.previewUrl;
  } else {
    browser.previewUrl = previewUrl;
  }

  config.browser = browser;
  pruneEmptyObjectProperty(config, "browser");
}

function applyProjectConfigUpdate(
  config: ProjectConfigJson,
  update: ProjectConfigFileUpdate,
): void {
  if (update.browserPreviewUrl !== undefined) {
    applyBrowserPreviewUrl(config, update.browserPreviewUrl);
  }

  if (update.scripts !== undefined) {
    config.scripts = [...update.scripts];
  }
}

export function updateProjectConfigJson(
  contents: string | null | undefined,
  update: ProjectConfigFileUpdate,
): string {
  const config = parseProjectConfigContents(contents);
  config.$schema = typeof config.$schema === "string" ? config.$schema : PROJECT_CONFIG_SCHEMA_URL;
  applyProjectConfigUpdate(config, update);

  return `${JSON.stringify(config, null, 2)}\n`;
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

export async function writeProjectConfigUpdate(input: {
  readonly api: EnvironmentApi;
  readonly projectCwd: string;
  readonly update: ProjectConfigFileUpdate;
}): Promise<void> {
  const existing = await input.api.projects.readFile({
    cwd: input.projectCwd,
    relativePath: PROJECT_CONFIG_RELATIVE_PATH,
  });

  await input.api.projects.writeFile({
    cwd: input.projectCwd,
    relativePath: PROJECT_CONFIG_RELATIVE_PATH,
    contents: updateProjectConfigJson(existing.contents, input.update),
  });
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
  applyBrowserPreviewUrl(config, previewUrl);
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
  readonly scripts: readonly ProjectScript[];
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
      config.scripts = [...input.scripts];
    },
  });
}
