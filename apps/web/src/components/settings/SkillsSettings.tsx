import type { ServerProvider, ServerProviderSkill } from "@t3tools/contracts";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  PlusIcon,
  PowerIcon,
  SearchIcon,
  ServerIcon,
  Trash2Icon,
  WandSparklesIcon,
} from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { openInPreferredEditor } from "../../editorPreferences";
import { ensureLocalApi } from "../../localApi";
import {
  formatProviderSkillDisplayName,
  formatProviderSkillInstallSource,
} from "../../providerSkillPresentation";
import { useServerProviders } from "../../rpc/serverState";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

type SkillEntry = {
  readonly provider: ServerProvider;
  readonly skill: ServerProviderSkill;
};

function providerLabel(provider: ServerProvider): string {
  return provider.displayName?.trim() || provider.driver;
}

function skillDescription(skill: ServerProviderSkill): string {
  return skill.shortDescription ?? skill.description ?? "No description provided.";
}

function searchableSkillText(entry: SkillEntry): string {
  const source = formatProviderSkillInstallSource(entry.skill) ?? "";
  return [
    entry.skill.name,
    formatProviderSkillDisplayName(entry.skill),
    skillDescription(entry.skill),
    entry.skill.scope ?? "",
    entry.skill.path,
    providerLabel(entry.provider),
    entry.provider.instanceId,
    source,
  ]
    .join("\n")
    .toLowerCase();
}

function collectSkillEntries(providers: ReadonlyArray<ServerProvider>): SkillEntry[] {
  return providers.flatMap((provider) =>
    provider.skills.map((skill) => ({
      provider,
      skill,
    })),
  );
}

function sortSkillEntries(entries: ReadonlyArray<SkillEntry>): SkillEntry[] {
  return [...entries].sort((left, right) => {
    const leftName = formatProviderSkillDisplayName(left.skill);
    const rightName = formatProviderSkillDisplayName(right.skill);
    const nameComparison = leftName.localeCompare(rightName);
    if (nameComparison !== 0) return nameComparison;

    return providerLabel(left.provider).localeCompare(providerLabel(right.provider));
  });
}

function filterSkillEntries(entries: ReadonlyArray<SkillEntry>, query: string): SkillEntry[] {
  const normalizedQuery = query.trim().replace(/^\$+/, "").toLowerCase();
  if (!normalizedQuery) return sortSkillEntries(entries);

  return sortSkillEntries(
    entries.filter((entry) => searchableSkillText(entry).includes(normalizedQuery)),
  );
}

function SkillSourceBadge({ skill }: { skill: ServerProviderSkill }) {
  const source = formatProviderSkillInstallSource(skill);
  if (!source) return null;

  return (
    <Badge variant="outline" size="sm" className="font-normal">
      {source}
    </Badge>
  );
}

function SkillPath({ path }: { path: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="block max-w-full truncate font-mono text-[11px] text-muted-foreground/70">
            {path}
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-[min(720px,calc(100vw-2rem))] break-all">
        {path}
      </TooltipPopup>
    </Tooltip>
  );
}

function skillActionKey(entry: SkillEntry, action: "toggle" | "delete"): string {
  return `${action}:${entry.provider.instanceId}:${entry.skill.name}:${entry.skill.path}`;
}

function canDeleteSkill(skill: ServerProviderSkill): boolean {
  return formatProviderSkillInstallSource(skill) === "Personal";
}

function SkillRow({
  entry,
  copiedKey,
  busyKey,
  onCopyToken,
  onOpenFile,
  onToggleEnabled,
  onDelete,
}: {
  entry: SkillEntry;
  copiedKey: string | null;
  busyKey: string | null;
  onCopyToken: (entry: SkillEntry) => void;
  onOpenFile: (entry: SkillEntry) => void;
  onToggleEnabled: (entry: SkillEntry) => void;
  onDelete: (entry: SkillEntry) => void;
}) {
  const displayName = formatProviderSkillDisplayName(entry.skill);
  const token = `$${entry.skill.name}`;
  const copyKey = `${entry.provider.instanceId}:${entry.skill.name}`;
  const isCopied = copiedKey === copyKey;
  const toggleKey = skillActionKey(entry, "toggle");
  const deleteKey = skillActionKey(entry, "delete");
  const isToggleBusy = busyKey === toggleKey;
  const isDeleteBusy = busyKey === deleteKey;
  const deleteEnabled = canDeleteSkill(entry.skill);

  return (
    <div className="flex flex-col gap-3 border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:flex-row sm:items-start sm:justify-between sm:px-5">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <h3 className="min-w-0 text-[13px] font-semibold tracking-[-0.01em] text-foreground">
            {displayName}
          </h3>
          <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {token}
          </code>
          <SkillSourceBadge skill={entry.skill} />
          <Badge variant={entry.skill.enabled ? "success" : "warning"} size="sm">
            {entry.skill.enabled ? "Enabled" : "Disabled"}
          </Badge>
        </div>
        <p className="text-xs leading-5 text-muted-foreground/85">
          {skillDescription(entry.skill)}
        </p>
        <div className="grid min-w-0 gap-1 text-[11px] text-muted-foreground sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <span className="min-w-0 truncate">
            Provider: <span className="text-foreground/70">{providerLabel(entry.provider)}</span>
          </span>
          <SkillPath path={entry.skill.path} />
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-start gap-2 sm:justify-end">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="min-w-20"
                onClick={() => onOpenFile(entry)}
              >
                <ExternalLinkIcon />
                Open File
              </Button>
            }
          />
          <TooltipPopup side="top">Open SKILL.md</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="min-w-20"
                disabled={isToggleBusy}
                onClick={() => onToggleEnabled(entry)}
              >
                <PowerIcon />
                {entry.skill.enabled ? "Disable" : "Enable"}
              </Button>
            }
          />
          <TooltipPopup side="top">
            {entry.skill.enabled ? "Disable this skill" : "Enable this skill"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="destructive-outline"
                disabled={!deleteEnabled || isDeleteBusy}
                onClick={() => onDelete(entry)}
              >
                <Trash2Icon />
                Delete
              </Button>
            }
          />
          <TooltipPopup side="top">
            {deleteEnabled
              ? "Delete this personal skill"
              : "Only personal Codex skills can be deleted"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="min-w-24"
                onClick={() => onCopyToken(entry)}
              >
                {isCopied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon />}
                {isCopied ? "Copied" : "Copy Token"}
              </Button>
            }
          />
          <TooltipPopup side="top">Copy {token}</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

function CreateSkillDialog({
  providers,
  open,
  onOpenChange,
  onCreated,
}: {
  providers: ReadonlyArray<ServerProvider>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (skillName: string) => void;
}) {
  const codexProviders = providers.filter((provider) => provider.driver === "codex");
  const [providerInstanceId, setProviderInstanceId] = useState("");
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [shortDescription, setShortDescription] = useState("");
  const [body, setBody] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProviderInstanceId((current) => current || codexProviders[0]?.instanceId || "");
  }, [codexProviders, open]);

  const resetForm = useCallback(() => {
    setName("");
    setDisplayName("");
    setDescription("");
    setShortDescription("");
    setBody("");
  }, []);

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const provider = codexProviders.find(
        (candidate) => candidate.instanceId === providerInstanceId,
      );
      const normalizedName = name.trim();
      const normalizedDescription = description.trim();
      if (!provider) {
        toastManager.add({
          title: "Choose a Codex provider",
          description: "Skills can only be created for Codex provider instances.",
          type: "error",
        });
        return;
      }
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(normalizedName)) {
        toastManager.add({
          title: "Invalid skill name",
          description: "Use letters, numbers, dashes, or underscores, starting with a letter.",
          type: "error",
        });
        return;
      }
      if (!normalizedDescription) {
        toastManager.add({
          title: "Description required",
          description: "Add the trigger description Codex should use to discover this skill.",
          type: "error",
        });
        return;
      }

      setIsSaving(true);
      void ensureLocalApi()
        .server.upsertSkill({
          instanceId: provider.instanceId,
          name: normalizedName,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
          description: normalizedDescription,
          ...(shortDescription.trim() ? { shortDescription: shortDescription.trim() } : {}),
          body,
          overwrite: false,
        })
        .then(
          () => {
            toastManager.add({
              title: "Skill created",
              description: `$${normalizedName} will appear after provider refresh completes.`,
              type: "success",
            });
            resetForm();
            onCreated(normalizedName);
            onOpenChange(false);
          },
          (error: unknown) => {
            toastManager.add({
              title: "Unable to create skill",
              description: error instanceof Error ? error.message : "The skill was not created.",
              type: "error",
            });
          },
        )
        .finally(() => setIsSaving(false));
    },
    [
      body,
      codexProviders,
      description,
      displayName,
      name,
      onCreated,
      onOpenChange,
      providerInstanceId,
      resetForm,
      shortDescription,
    ],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create Skill</DialogTitle>
          <DialogDescription>
            Create a personal Codex skill under the selected provider's CODEX_HOME.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <DialogPanel className="grid gap-4">
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              Provider
              <select
                value={providerInstanceId}
                onChange={(event) => setProviderInstanceId(event.currentTarget.value)}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                disabled={codexProviders.length === 0 || isSaving}
              >
                {codexProviders.length === 0 ? (
                  <option value="">No Codex providers</option>
                ) : (
                  codexProviders.map((provider) => (
                    <option key={provider.instanceId} value={provider.instanceId}>
                      {providerLabel(provider)}
                    </option>
                  ))
                )}
              </select>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-xs font-medium text-foreground">
                Name
                <Input
                  nativeInput
                  size="sm"
                  value={name}
                  onChange={(event) => setName(event.currentTarget.value)}
                  placeholder="review-follow-up"
                  disabled={isSaving}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-foreground">
                Display name
                <Input
                  nativeInput
                  size="sm"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.currentTarget.value)}
                  placeholder="Review Follow Up"
                  disabled={isSaving}
                />
              </label>
            </div>
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              Description
              <Textarea
                size="sm"
                value={description}
                onChange={(event) => setDescription(event.currentTarget.value)}
                placeholder="Use when Codex should..."
                disabled={isSaving}
              />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              Short description
              <Input
                nativeInput
                size="sm"
                value={shortDescription}
                onChange={(event) => setShortDescription(event.currentTarget.value)}
                placeholder="Optional list summary"
                disabled={isSaving}
              />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              Instructions
              <Textarea
                size="lg"
                value={body}
                onChange={(event) => setBody(event.currentTarget.value)}
                placeholder="Add the workflow, constraints, and examples for this skill."
                className="[&_[data-slot=textarea]]:min-h-36"
                disabled={isSaving}
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving || codexProviders.length === 0}>
              <PlusIcon />
              Create Skill
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function SkillsEmptyState({
  providersCount,
  hasQuery,
}: {
  providersCount: number;
  hasQuery: boolean;
}) {
  const title = hasQuery
    ? "No matching skills"
    : providersCount === 0
      ? "No providers connected"
      : "No skills discovered";
  const description = hasQuery
    ? "Adjust the filter to search names, descriptions, providers, sources, or paths."
    : providersCount === 0
      ? "Connect a provider that exposes skills, then return here to browse and copy skill tokens."
      : "The connected providers did not report any skills in their latest status snapshot.";

  return (
    <div className="px-5 py-8 text-center">
      <div className="mx-auto flex size-9 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground">
        <WandSparklesIcon className="size-4" />
      </div>
      <h3 className="mt-3 text-sm font-semibold text-foreground">{title}</h3>
      <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground/80">
        {description}
      </p>
    </div>
  );
}

export function SkillsSettings() {
  const providers = useServerProviders();
  const [query, setQuery] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const copiedTimeoutRef = useRef<number | null>(null);

  const allEntries = useMemo(() => collectSkillEntries(providers), [providers]);
  const filteredEntries = useMemo(() => filterSkillEntries(allEntries, query), [allEntries, query]);
  const enabledCount = allEntries.filter((entry) => entry.skill.enabled).length;
  const hasQuery = query.trim().length > 0;

  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
      }
    };
  }, []);

  const copySkillToken = useCallback((entry: SkillEntry) => {
    const token = `$${entry.skill.name}`;
    const copyKey = `${entry.provider.instanceId}:${entry.skill.name}`;

    if (!navigator.clipboard?.writeText) {
      toastManager.add({
        title: "Unable to copy skill token",
        description: "The clipboard is not available in this browser.",
        type: "error",
      });
      return;
    }

    void navigator.clipboard.writeText(token).then(
      () => {
        if (copiedTimeoutRef.current !== null) {
          window.clearTimeout(copiedTimeoutRef.current);
        }
        setCopiedKey(copyKey);
        copiedTimeoutRef.current = window.setTimeout(() => {
          setCopiedKey(null);
          copiedTimeoutRef.current = null;
        }, 1_500);
      },
      () => {
        toastManager.add({
          title: "Unable to copy skill token",
          description: "The clipboard is not available in this browser.",
          type: "error",
        });
      },
    );
  }, []);

  const openSkillFile = useCallback((entry: SkillEntry) => {
    void (async () => {
      try {
        await openInPreferredEditor(ensureLocalApi(), entry.skill.path);
      } catch (error: unknown) {
        toastManager.add({
          title: "Unable to open skill file",
          description: error instanceof Error ? error.message : "The skill file was not opened.",
          type: "error",
        });
      }
    })();
  }, []);

  const toggleSkillEnabled = useCallback((entry: SkillEntry) => {
    const key = skillActionKey(entry, "toggle");
    setBusyKey(key);
    void ensureLocalApi()
      .server.setSkillEnabled({
        instanceId: entry.provider.instanceId,
        path: entry.skill.path,
        enabled: !entry.skill.enabled,
      })
      .then(
        () => {
          toastManager.add({
            title: entry.skill.enabled ? "Skill disabled" : "Skill enabled",
            description: `$${entry.skill.name} provider metadata is refreshing.`,
            type: "success",
          });
        },
        (error: unknown) => {
          toastManager.add({
            title: "Unable to update skill",
            description: error instanceof Error ? error.message : "The skill was not updated.",
            type: "error",
          });
        },
      )
      .finally(() => setBusyKey((current) => (current === key ? null : current)));
  }, []);

  const deleteSkill = useCallback((entry: SkillEntry) => {
    if (
      !window.confirm(
        `Delete ${formatProviderSkillDisplayName(entry.skill)}?\n\nThis permanently removes its skill directory.`,
      )
    ) {
      return;
    }
    const key = skillActionKey(entry, "delete");
    setBusyKey(key);
    void ensureLocalApi()
      .server.deleteSkill({
        instanceId: entry.provider.instanceId,
        path: entry.skill.path,
      })
      .then(
        () => {
          toastManager.add({
            title: "Skill deleted",
            description: `$${entry.skill.name} provider metadata is refreshing.`,
            type: "success",
          });
        },
        (error: unknown) => {
          toastManager.add({
            title: "Unable to delete skill",
            description: error instanceof Error ? error.message : "The skill was not deleted.",
            type: "error",
          });
        },
      )
      .finally(() => setBusyKey((current) => (current === key ? null : current)));
  }, []);

  return (
    <SettingsPageContainer className="max-w-4xl">
      <div className="space-y-1 px-1">
        <h1 className="text-lg font-semibold tracking-[-0.02em] text-foreground">Skills & MCP</h1>
        <p className="text-sm text-muted-foreground/80">
          Browse provider skills that can be inserted into prompts. MCP server management is planned
          but not available yet.
        </p>
      </div>

      <CreateSkillDialog
        providers={providers}
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreated={setQuery}
      />

      <SettingsSection
        title="Skills"
        icon={<WandSparklesIcon className="size-3.5" />}
        headerAction={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => setCreateDialogOpen(true)}
            >
              <PlusIcon />
              Add Skill
            </Button>
            <div className="relative w-48 sm:w-64">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                nativeInput
                type="search"
                size="sm"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Filter skills"
                aria-label="Filter skills"
                className="rounded-md [&_[data-slot=input]]:pl-8"
              />
              <span className="pointer-events-none absolute inset-y-0 left-0 w-8" aria-hidden />
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-2 border-b border-border/60 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-foreground">
              {allEntries.length} skills discovered
            </p>
            <p className="text-xs text-muted-foreground/80">
              {enabledCount} enabled across {providers.length} provider
              {providers.length === 1 ? "" : "s"}.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="success" size="sm">
              {enabledCount} Enabled
            </Badge>
            <Badge variant="outline" size="sm">
              {allEntries.length - enabledCount} Disabled
            </Badge>
          </div>
        </div>

        {filteredEntries.length === 0 ? (
          <SkillsEmptyState providersCount={providers.length} hasQuery={hasQuery} />
        ) : (
          filteredEntries.map((entry) => (
            <SkillRow
              key={`${entry.provider.instanceId}:${entry.skill.name}:${entry.skill.path}`}
              entry={entry}
              copiedKey={copiedKey}
              busyKey={busyKey}
              onCopyToken={copySkillToken}
              onOpenFile={openSkillFile}
              onToggleEnabled={toggleSkillEnabled}
              onDelete={deleteSkill}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection title="MCP Servers" icon={<ServerIcon className="size-3.5" />}>
        <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <h3 className="text-[13px] font-semibold text-foreground">Server management</h3>
              <Badge variant="warning" size="sm">
                WIP
              </Badge>
            </div>
            <p className="max-w-2xl text-xs leading-5 text-muted-foreground/80">
              MCP server management is not available right now. This panel is reserved for future
              app-level MCP configuration.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" size="xs" variant="outline" disabled>
              Add Server
            </Button>
            <Button type="button" size="xs" variant="outline" disabled>
              Configure
            </Button>
          </div>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
