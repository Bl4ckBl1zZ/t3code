import type { CodexSettings, ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";

function command(
  name: string,
  description: string,
  inputHint?: string,
): ServerProviderSlashCommand {
  return {
    name,
    description,
    ...(inputHint ? { input: { hint: inputHint } } : {}),
  };
}

export const CODEX_BUILT_IN_SLASH_COMMANDS = [
  command("permissions", "Set what Codex can do without asking first."),
  command("ide", "Include open files, current selection, and other IDE context.", "[PROMPT]"),
  command("keymap", "Remap TUI keyboard shortcuts."),
  command("vim", "Toggle Vim mode for the composer."),
  command("sandbox-add-read-dir", "Grant sandbox read access to an extra directory.", "PATH"),
  command("agent", "Switch the active agent thread."),
  command("apps", "Browse apps and insert them into your prompt."),
  command("plugins", "Browse installed and discoverable plugins."),
  command("hooks", "Review lifecycle hooks."),
  command("clear", "Clear the terminal and start a fresh chat."),
  command("compact", "Summarize the visible conversation to free tokens."),
  command("copy", "Copy the latest completed Codex output."),
  command("diff", "Show the Git diff, including untracked files."),
  command("exit", "Exit the CLI, same as /quit."),
  command("experimental", "Toggle experimental features."),
  command("approve", "Approve one retry of a recent auto-review denial."),
  command("memories", "Configure memory use and generation."),
  command("skills", "Browse and use skills."),
  command("feedback", "Send logs to the Codex maintainers."),
  command("init", "Generate an AGENTS.md scaffold in the current directory."),
  command("logout", "Sign out of Codex."),
  command("mcp", "List configured Model Context Protocol tools.", "[verbose]"),
  command("mention", "Attach a file to the conversation.", "PATH"),
  command("model", "Choose the active model.", "[MODEL]"),
  command("fast", "Toggle or inspect Fast service tier.", "on|off|status"),
  command("plan", "Switch to plan mode and optionally send a prompt.", "[PROMPT]"),
  command(
    "goal",
    "Set, view, pause, resume, or clear a task goal.",
    "[OBJECTIVE|pause|resume|clear]",
  ),
  command("personality", "Choose a communication style for responses."),
  command("ps", "Show background terminals and recent output."),
  command("stop", "Stop all background terminals."),
  command("fork", "Fork the current conversation into a new thread."),
  command("side", "Start an ephemeral side conversation.", "[PROMPT]"),
  command("btw", "Start an ephemeral side conversation.", "[PROMPT]"),
  command("raw", "Toggle raw scrollback mode."),
  command("resume", "Resume a saved conversation from your session list."),
  command("new", "Start a new conversation inside the same CLI session."),
  command("quit", "Exit the CLI."),
  command("review", "Ask Codex to review your working tree.", "[BASE|COMMIT|PROMPT]"),
  command("status", "Display session configuration and token usage."),
  command("debug-config", "Print config layer and requirements diagnostics."),
  command("statusline", "Configure TUI status-line fields interactively."),
  command("title", "Configure terminal window or tab title fields interactively."),
  command("theme", "Choose a syntax-highlighting theme."),
] as const satisfies ReadonlyArray<ServerProviderSlashCommand>;

export interface CodexPromptMetadata {
  readonly description?: string;
  readonly argumentHint?: string;
}

function unquoteFrontmatterScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote) {
    return trimmed;
  }
  const inner = trimmed.slice(1, -1);
  return quote === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner;
}

export function parseCodexPromptMetadata(contents: string): CodexPromptMetadata {
  const normalized = contents.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return {};
  }

  const frontmatterEnd = normalized.indexOf("\n---\n", 4);
  if (frontmatterEnd === -1) {
    return {};
  }

  const metadata: { description?: string; argumentHint?: string } = {};
  const frontmatter = normalized.slice(4, frontmatterEnd);
  for (const line of frontmatter.split("\n")) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;

    const key = match[1];
    const rawValue = match[2] ?? "";
    const value = unquoteFrontmatterScalar(rawValue).trim();
    if (!value) continue;

    if (key === "description") {
      metadata.description = value;
    } else if (key === "argument-hint") {
      metadata.argumentHint = value;
    }
  }

  return metadata;
}

function promptCommandName(entryName: string): string | null {
  const lower = entryName.toLowerCase();
  const suffix = lower.endsWith(".markdown") ? ".markdown" : lower.endsWith(".md") ? ".md" : null;
  if (!suffix) return null;

  const stem = entryName.slice(0, -suffix.length).trim();
  if (!stem || stem.includes("/") || stem.includes("\\")) return null;
  return `prompts:${stem}`;
}

const readPromptSlashCommands = Effect.fn("readPromptSlashCommands")(function* (
  promptDirectories: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commands: ServerProviderSlashCommand[] = [];
  const seenDirectories = new Set<string>();

  for (const promptDirectory of promptDirectories) {
    const normalizedDirectory = path.resolve(promptDirectory);
    if (seenDirectories.has(normalizedDirectory)) continue;
    seenDirectories.add(normalizedDirectory);

    const exists = yield* fileSystem
      .exists(normalizedDirectory)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) continue;

    const entries = yield* fileSystem
      .readDirectory(normalizedDirectory)
      .pipe(Effect.orElseSucceed(() => [] as string[]));
    for (const entryName of [...entries].sort((left, right) => left.localeCompare(right))) {
      const name = promptCommandName(entryName);
      if (!name) continue;

      const contents = yield* fileSystem
        .readFileString(path.join(normalizedDirectory, entryName))
        .pipe(Effect.orElseSucceed(() => null));
      if (contents === null) continue;

      const metadata = parseCodexPromptMetadata(contents);
      commands.push({
        name,
        description: metadata.description ?? `Run custom prompt ${name.slice("prompts:".length)}.`,
        ...(metadata.argumentHint ? { input: { hint: metadata.argumentHint } } : {}),
      });
    }
  }

  return commands;
});

export function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const byName = new Map<string, ServerProviderSlashCommand>();
  for (const command of commands) {
    const name = command.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const existing = byName.get(key);
    byName.set(key, {
      name,
      ...(existing?.description || command.description
        ? { description: command.description ?? existing?.description }
        : {}),
      ...(existing?.input || command.input ? { input: command.input ?? existing?.input } : {}),
    });
  }
  return [...byName.values()];
}

export const listCodexSlashCommands = Effect.fn("listCodexSlashCommands")(function* (input: {
  readonly codexSettings: CodexSettings;
  readonly cwd?: string;
}) {
  const path = yield* Path.Path;
  const homeLayout = yield* resolveCodexHomeLayout(input.codexSettings);
  const promptDirectories = [
    path.join(homeLayout.sharedHomePath, "prompts"),
    ...(input.cwd ? [path.join(path.resolve(input.cwd), ".codex", "prompts")] : []),
  ];
  const promptCommands = yield* readPromptSlashCommands(promptDirectories);
  return dedupeSlashCommands([...CODEX_BUILT_IN_SLASH_COMMANDS, ...promptCommands]);
});
