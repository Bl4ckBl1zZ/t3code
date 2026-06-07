import type { EnvironmentId, WorkspaceId } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FilePlusIcon,
  FolderPlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  PencilIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  type KeyboardEvent,
} from "react";

import { useTheme } from "../../hooks/useTheme";
import {
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspacePath,
  renameWorkspacePath,
  useWorkspaceDirectory,
  workspaceTreeManager,
} from "../../lib/workspaceFileState";
import { cn } from "../../lib/utils";
import { useWorkbenchStore } from "../../workbenchStore";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface WorkspaceExplorerTarget {
  readonly environmentId: EnvironmentId;
  readonly workspaceId?: WorkspaceId | undefined;
  readonly cwd: string;
  readonly label: string;
}

interface WorkspaceExplorerProps {
  readonly target: WorkspaceExplorerTarget | null;
  readonly activeRelativePath: string | null;
  readonly revealRequest?: {
    readonly requestId: number;
    readonly environmentId: EnvironmentId;
    readonly workspaceId?: WorkspaceId | undefined;
    readonly cwd: string;
    readonly relativePath: string;
  } | null;
}

type InlineEdit =
  | {
      readonly mode: "create-file" | "create-folder";
      readonly parentPath: string;
      readonly value: string;
    }
  | {
      readonly mode: "rename";
      readonly oldPath: string;
      readonly value: string;
    };

function parentPathOf(pathValue: string): string {
  const normalized = pathValue.replaceAll("\\", "/").replace(/\/+$/g, "");
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex === -1 ? "" : normalized.slice(0, separatorIndex);
}

function joinPath(parentPath: string, name: string): string {
  const trimmed = name.trim().replace(/^\/+|\/+$/g, "");
  return parentPath ? `${parentPath}/${trimmed}` : trimmed;
}

function ancestorDirectoryPaths(pathValue: string): string[] {
  const ancestors = [""];
  let current = parentPathOf(pathValue);
  while (current) {
    ancestors.push(current);
    current = parentPathOf(current);
  }
  return ancestors;
}

const ExplorerButton = memo(function ExplorerButton({
  label,
  children,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-hidden hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});

function InlineEditRow({
  depth,
  edit,
  setEdit,
  target,
  refreshParent,
}: {
  readonly depth: number;
  readonly edit: InlineEdit;
  readonly setEdit: (edit: InlineEdit | null) => void;
  readonly target: WorkspaceExplorerTarget;
  readonly refreshParent: (relativePath: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const commit = useCallback(() => {
    const value = edit.value.trim();
    if (!value) {
      setEdit(null);
      return;
    }
    const run = async () => {
      if (edit.mode === "create-file") {
        const relativePath = joinPath(edit.parentPath, value);
        await createWorkspaceFile(target.environmentId, {
          cwd: target.cwd,
          relativePath,
          contents: "",
        });
        refreshParent(edit.parentPath);
      } else if (edit.mode === "create-folder") {
        const relativePath = joinPath(edit.parentPath, value);
        await createWorkspaceDirectory(target.environmentId, {
          cwd: target.cwd,
          relativePath,
        });
        refreshParent(edit.parentPath);
      } else if (edit.mode === "rename") {
        const relativePath = joinPath(parentPathOf(edit.oldPath), value);
        await renameWorkspacePath(target.environmentId, {
          cwd: target.cwd,
          fromRelativePath: edit.oldPath,
          toRelativePath: relativePath,
        });
        refreshParent(parentPathOf(edit.oldPath));
      }
      setEdit(null);
    };
    void run().catch((error) => {
      window.alert(error instanceof Error ? error.message : "Workspace file operation failed.");
    });
  }, [edit, refreshParent, setEdit, target.cwd, target.environmentId]);

  return (
    <div
      className="flex h-7 items-center gap-1 px-1 text-xs"
      style={{ paddingLeft: depth * 14 + 8 }}
    >
      <input
        ref={inputRef}
        autoFocus
        className="h-6 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        value={edit.value}
        onChange={(event) => setEdit({ ...edit, value: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setEdit(null);
          }
        }}
        onBlur={() => {
          window.setTimeout(() => {
            if (document.activeElement !== inputRef.current) {
              setEdit(null);
            }
          }, 120);
        }}
      />
    </div>
  );
}

function DirectoryRows({
  target,
  relativePath,
  depth,
  expanded,
  selectedPath,
  activeRelativePath,
  includeHidden,
  includeIgnored,
  inlineEdit,
  setExpanded,
  setSelectedPath,
  setInlineEdit,
}: {
  readonly target: WorkspaceExplorerTarget;
  readonly relativePath: string;
  readonly depth: number;
  readonly expanded: ReadonlySet<string>;
  readonly selectedPath: string | null;
  readonly activeRelativePath: string | null;
  readonly includeHidden: boolean;
  readonly includeIgnored: boolean;
  readonly inlineEdit: InlineEdit | null;
  readonly setExpanded: Dispatch<SetStateAction<ReadonlySet<string>>>;
  readonly setSelectedPath: (path: string | null) => void;
  readonly setInlineEdit: (edit: InlineEdit | null) => void;
}) {
  const state = useWorkspaceDirectory(
    { environmentId: target.environmentId, cwd: target.cwd, relativePath },
    { includeHidden, includeIgnored, limit: 1000 },
  );
  const openFileTab = useWorkbenchStore((store) => store.openFileTab);
  const { resolvedTheme } = useTheme();

  const refreshParent = useCallback(
    (directoryPath: string) => {
      void workspaceTreeManager.refresh(
        { environmentId: target.environmentId, cwd: target.cwd, relativePath: directoryPath },
        { includeHidden, includeIgnored, limit: 1000, force: true },
      );
    },
    [includeHidden, includeIgnored, target.cwd, target.environmentId],
  );

  const toggleDirectory = useCallback(
    (pathValue: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(pathValue)) {
          next.delete(pathValue);
        } else {
          next.add(pathValue);
        }
        return next;
      });
    },
    [setExpanded],
  );

  if (state.error) {
    return (
      <div className="px-3 py-2 text-xs text-destructive" style={{ paddingLeft: depth * 14 + 12 }}>
        {state.error}
      </div>
    );
  }

  return (
    <>
      {inlineEdit?.mode !== "rename" && inlineEdit?.parentPath === relativePath ? (
        <InlineEditRow
          depth={depth}
          edit={inlineEdit}
          setEdit={setInlineEdit}
          target={target}
          refreshParent={refreshParent}
        />
      ) : null}
      {state.isPending && !state.data ? (
        <div
          className="px-3 py-2 text-xs text-muted-foreground"
          style={{ paddingLeft: depth * 14 + 12 }}
        >
          Loading...
        </div>
      ) : null}
      {state.data?.entries.map((entry) => {
        const isDirectory = entry.kind === "directory";
        const isSelected = selectedPath === entry.relativePath;
        const isActive = activeRelativePath === entry.relativePath;
        const entryExpanded = expanded.has(entry.relativePath);
        const rowDepth = depth;
        if (inlineEdit?.mode === "rename" && inlineEdit.oldPath === entry.relativePath) {
          return (
            <InlineEditRow
              key={entry.relativePath}
              depth={rowDepth}
              edit={inlineEdit}
              setEdit={setInlineEdit}
              target={target}
              refreshParent={refreshParent}
            />
          );
        }
        return (
          <div key={entry.relativePath}>
            <div
              data-explorer-path={entry.relativePath}
              data-explorer-kind={entry.kind}
              className={cn(
                "group/row flex h-7 items-center gap-1 rounded-sm px-1 text-xs outline-hidden",
                isSelected && "bg-muted text-foreground",
                isActive && !isSelected && "bg-primary/8 text-foreground",
                !isSelected &&
                  !isActive &&
                  "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              style={{ paddingLeft: rowDepth * 14 + 4 }}
              role="treeitem"
              aria-selected={isSelected}
              aria-expanded={isDirectory ? entryExpanded : undefined}
              onClick={() => {
                setSelectedPath(entry.relativePath);
                if (isDirectory) {
                  toggleDirectory(entry.relativePath);
                } else if (entry.kind === "file" || entry.kind === "symlink") {
                  openFileTab({
                    environmentId: target.environmentId,
                    ...(target.workspaceId !== undefined
                      ? { workspaceId: target.workspaceId }
                      : {}),
                    cwd: target.cwd,
                    relativePath: entry.relativePath,
                  });
                }
              }}
            >
              <button
                type="button"
                className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-muted"
                tabIndex={-1}
                aria-label={entryExpanded ? "Collapse folder" : "Expand folder"}
                onClick={(event) => {
                  event.stopPropagation();
                  if (isDirectory) {
                    toggleDirectory(entry.relativePath);
                  }
                }}
              >
                {isDirectory ? (
                  entryExpanded ? (
                    <ChevronDownIcon className="size-3.5" />
                  ) : (
                    <ChevronRightIcon className="size-3.5" />
                  )
                ) : null}
              </button>
              <VscodeEntryIcon
                pathValue={entry.relativePath}
                kind={isDirectory ? "directory" : "file"}
                theme={resolvedTheme}
                className="size-4"
              />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              <span className="hidden shrink-0 items-center gap-0.5 group-hover/row:flex">
                <button
                  type="button"
                  className="flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={`Rename ${entry.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedPath(entry.relativePath);
                    setInlineEdit({
                      mode: "rename",
                      oldPath: entry.relativePath,
                      value: entry.name,
                    });
                  }}
                >
                  <PencilIcon className="size-3" />
                </button>
                <button
                  type="button"
                  className="flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`Delete ${entry.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    const confirmed = window.confirm(`Delete ${entry.relativePath}?`);
                    if (!confirmed) return;
                    void deleteWorkspacePath(target.environmentId, {
                      cwd: target.cwd,
                      relativePath: entry.relativePath,
                    }).catch((error) => {
                      window.alert(
                        error instanceof Error ? error.message : "Workspace delete failed.",
                      );
                    });
                  }}
                >
                  <Trash2Icon className="size-3" />
                </button>
              </span>
            </div>
            {isDirectory && entryExpanded ? (
              <DirectoryRows
                target={target}
                relativePath={entry.relativePath}
                depth={depth + 1}
                expanded={expanded}
                selectedPath={selectedPath}
                activeRelativePath={activeRelativePath}
                includeHidden={includeHidden}
                includeIgnored={includeIgnored}
                inlineEdit={inlineEdit}
                setExpanded={setExpanded}
                setSelectedPath={setSelectedPath}
                setInlineEdit={setInlineEdit}
              />
            ) : null}
          </div>
        );
      })}
      {state.data?.truncated ? (
        <div
          className="px-3 py-1 text-[11px] text-muted-foreground"
          style={{ paddingLeft: depth * 14 + 12 }}
        >
          Directory listing truncated
        </div>
      ) : null}
    </>
  );
}

export function WorkspaceExplorer({
  target,
  activeRelativePath,
  revealRequest,
}: WorkspaceExplorerProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([""]));
  const [selectedPath, setSelectedPath] = useState<string | null>(activeRelativePath);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const previousTargetKeyRef = useRef<string | null>(null);
  const targetKey = target ? `${target.environmentId}\n${target.cwd}` : null;

  useEffect(() => {
    if (previousTargetKeyRef.current === targetKey) {
      return;
    }
    previousTargetKeyRef.current = targetKey;
    setSelectedPath(activeRelativePath);
    setExpanded(() => {
      const next = new Set<string>([""]);
      if (activeRelativePath) {
        for (const ancestor of ancestorDirectoryPaths(activeRelativePath)) {
          next.add(ancestor);
        }
      }
      return next;
    });
    setInlineEdit(null);
  }, [activeRelativePath, targetKey]);

  useEffect(() => {
    if (
      !target ||
      !revealRequest ||
      target.environmentId !== revealRequest.environmentId ||
      (revealRequest.workspaceId !== undefined &&
        target.workspaceId !== revealRequest.workspaceId) ||
      target.cwd !== revealRequest.cwd
    ) {
      return;
    }
    setSelectedPath(revealRequest.relativePath);
    setExpanded((current) => {
      const next = new Set(current);
      for (const ancestor of ancestorDirectoryPaths(revealRequest.relativePath)) {
        next.add(ancestor);
      }
      return next;
    });
    window.setTimeout(() => {
      rootRef.current
        ?.querySelector<HTMLElement>(
          `[data-explorer-path="${CSS.escape(revealRequest.relativePath)}"]`,
        )
        ?.scrollIntoView({ block: "nearest" });
    }, 0);
  }, [revealRequest, target]);

  const selectedDirectoryPath = useMemo(() => {
    if (!selectedPath) return "";
    const selectedRow = rootRef.current?.querySelector<HTMLElement>(
      `[data-explorer-path="${CSS.escape(selectedPath)}"]`,
    );
    if (selectedRow?.dataset.explorerKind === "directory") return selectedPath;
    return parentPathOf(selectedPath);
  }, [selectedPath]);

  const refreshSelected = useCallback(() => {
    if (!target) return;
    void workspaceTreeManager.refresh(
      { environmentId: target.environmentId, cwd: target.cwd, relativePath: selectedDirectoryPath },
      { includeHidden, includeIgnored, limit: 1000, force: true },
    );
  }, [includeHidden, includeIgnored, selectedDirectoryPath, target]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!rootRef.current || event.defaultPrevented) {
        return;
      }
      const rows = Array.from(
        rootRef.current.querySelectorAll<HTMLElement>("[data-explorer-path]"),
      );
      if (rows.length === 0) return;
      const currentIndex = Math.max(
        0,
        rows.findIndex((row) => row.dataset.explorerPath === selectedPath),
      );
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const nextIndex =
          event.key === "ArrowDown"
            ? Math.min(rows.length - 1, currentIndex + 1)
            : Math.max(0, currentIndex - 1);
        setSelectedPath(rows[nextIndex]?.dataset.explorerPath ?? null);
      }
      if (event.key === "Enter") {
        event.preventDefault();
        rows[currentIndex]?.click();
      }
      if (event.key === "ArrowRight") {
        const pathValue = rows[currentIndex]?.dataset.explorerPath;
        if (pathValue && rows[currentIndex]?.dataset.explorerKind === "directory") {
          event.preventDefault();
          setExpanded((current) => new Set(current).add(pathValue));
        }
      }
      if (event.key === "ArrowLeft") {
        const pathValue = rows[currentIndex]?.dataset.explorerPath;
        if (!pathValue) return;
        event.preventDefault();
        if (expanded.has(pathValue)) {
          setExpanded((current) => {
            const next = new Set(current);
            next.delete(pathValue);
            return next;
          });
        } else {
          setSelectedPath(parentPathOf(pathValue));
        }
      }
      if (event.key === "Escape") {
        setInlineEdit(null);
      }
    },
    [expanded, selectedPath],
  );

  if (!target) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        No active workspace
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace-explorer">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{target.label}</div>
          <div className="truncate text-[10px] text-muted-foreground">{target.cwd}</div>
        </div>
        <ExplorerButton
          label="New file"
          onClick={() =>
            setInlineEdit({ mode: "create-file", parentPath: selectedDirectoryPath, value: "" })
          }
        >
          <FilePlusIcon className="size-3.5" />
        </ExplorerButton>
        <ExplorerButton
          label="New folder"
          onClick={() =>
            setInlineEdit({ mode: "create-folder", parentPath: selectedDirectoryPath, value: "" })
          }
        >
          <FolderPlusIcon className="size-3.5" />
        </ExplorerButton>
        <ExplorerButton label="Refresh" onClick={refreshSelected}>
          <RefreshCwIcon className="size-3.5" />
        </ExplorerButton>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-3 text-[11px] text-muted-foreground">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            className="size-3"
            checked={includeHidden}
            onChange={(event) => setIncludeHidden(event.target.checked)}
          />
          Hidden
        </label>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            className="size-3"
            checked={includeIgnored}
            onChange={(event) => setIncludeIgnored(event.target.checked)}
          />
          Ignored
        </label>
      </div>
      <div
        ref={rootRef}
        className="min-h-0 flex-1 overflow-auto px-1 py-1"
        role="tree"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <DirectoryRows
          target={target}
          relativePath=""
          depth={0}
          expanded={expanded}
          selectedPath={selectedPath}
          activeRelativePath={activeRelativePath}
          includeHidden={includeHidden}
          includeIgnored={includeIgnored}
          inlineEdit={inlineEdit}
          setExpanded={setExpanded}
          setSelectedPath={setSelectedPath}
          setInlineEdit={setInlineEdit}
        />
      </div>
    </div>
  );
}
