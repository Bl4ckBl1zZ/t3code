import type { OrchestrationCheckpointFile } from "@t3tools/contracts";

// Mobile port of apps/web/src/lib/turnDiffTree.ts: builds the per-turn
// changed-files tree (with single-child directory compaction) from a
// checkpoint's file list.

export interface TurnDiffStat {
  additions: number;
  deletions: number;
}

export interface TurnDiffTreeDirectoryNode {
  kind: "directory";
  name: string;
  path: string;
  stat: TurnDiffStat;
  children: TurnDiffTreeNode[];
}

export interface TurnDiffTreeFileNode {
  kind: "file";
  name: string;
  path: string;
  stat: TurnDiffStat | null;
}

export type TurnDiffTreeNode = TurnDiffTreeDirectoryNode | TurnDiffTreeFileNode;

interface MutableDirectoryNode {
  name: string;
  path: string;
  stat: TurnDiffStat;
  directories: Map<string, MutableDirectoryNode>;
  files: TurnDiffTreeFileNode[];
}

const SORT_LOCALE_OPTIONS: Intl.CollatorOptions = { numeric: true, sensitivity: "base" };

function normalizePathSegments(pathValue: string): string[] {
  return pathValue
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);
}

function compareByName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, SORT_LOCALE_OPTIONS);
}

function readStat(file: OrchestrationCheckpointFile): TurnDiffStat | null {
  if (typeof file.additions !== "number" || typeof file.deletions !== "number") {
    return null;
  }
  return {
    additions: file.additions,
    deletions: file.deletions,
  };
}

function compactDirectoryNode(node: TurnDiffTreeDirectoryNode): TurnDiffTreeDirectoryNode {
  const compactedChildren = node.children.map((child) =>
    child.kind === "directory" ? compactDirectoryNode(child) : child,
  );

  let compactedNode: TurnDiffTreeDirectoryNode = {
    ...node,
    children: compactedChildren,
  };

  while (compactedNode.children.length === 1 && compactedNode.children[0]?.kind === "directory") {
    const onlyChild = compactedNode.children[0];
    compactedNode = {
      kind: "directory",
      name: `${compactedNode.name}/${onlyChild.name}`,
      path: onlyChild.path,
      stat: onlyChild.stat,
      children: onlyChild.children,
    };
  }

  return compactedNode;
}

function toTreeNodes(directory: MutableDirectoryNode): TurnDiffTreeNode[] {
  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023
  // change-by-copy methods.
  const subdirectories: TurnDiffTreeDirectoryNode[] = Array.from(directory.directories.values())
    .sort(compareByName)
    .map<TurnDiffTreeDirectoryNode>((subdirectory) => ({
      kind: "directory",
      name: subdirectory.name,
      path: subdirectory.path,
      stat: {
        additions: subdirectory.stat.additions,
        deletions: subdirectory.stat.deletions,
      },
      children: toTreeNodes(subdirectory),
    }))
    .map((subdirectory) => compactDirectoryNode(subdirectory));

  const files = [...directory.files].sort(compareByName);
  return [...subdirectories, ...files];
}

export function summarizeTurnDiffStats(
  files: ReadonlyArray<OrchestrationCheckpointFile>,
): TurnDiffStat {
  return files.reduce<TurnDiffStat>(
    (acc, file) => {
      const stat = readStat(file);
      if (!stat) return acc;
      return {
        additions: acc.additions + stat.additions,
        deletions: acc.deletions + stat.deletions,
      };
    },
    { additions: 0, deletions: 0 },
  );
}

const AUTO_EXPAND_FILE_LIMIT = 5;
const AUTO_EXPAND_LINE_LIMIT = 200;

// Same rule as the web timeline: only the latest turn auto-expands, and only
// when the diff is small enough to scan at a glance.
export function shouldAutoExpandChangedFiles(
  files: ReadonlyArray<OrchestrationCheckpointFile>,
  isLatestTurn: boolean,
): boolean {
  if (!isLatestTurn || files.length > AUTO_EXPAND_FILE_LIMIT) {
    return false;
  }
  const stat = summarizeTurnDiffStats(files);
  return stat.additions + stat.deletions <= AUTO_EXPAND_LINE_LIMIT;
}

export function buildTurnDiffTree(
  files: ReadonlyArray<OrchestrationCheckpointFile>,
): TurnDiffTreeNode[] {
  const root: MutableDirectoryNode = {
    name: "",
    path: "",
    stat: { additions: 0, deletions: 0 },
    directories: new Map(),
    files: [],
  };

  for (const file of files) {
    const segments = normalizePathSegments(file.path);
    if (segments.length === 0) {
      continue;
    }

    const filePath = segments.join("/");
    const fileName = segments.at(-1);
    if (!fileName) {
      continue;
    }
    const stat = readStat(file);
    const ancestors: MutableDirectoryNode[] = [root];
    let currentDirectory = root;

    for (const segment of segments.slice(0, -1)) {
      const nextPath = currentDirectory.path ? `${currentDirectory.path}/${segment}` : segment;
      const existing = currentDirectory.directories.get(segment);
      if (existing) {
        currentDirectory = existing;
      } else {
        const created: MutableDirectoryNode = {
          name: segment,
          path: nextPath,
          stat: { additions: 0, deletions: 0 },
          directories: new Map(),
          files: [],
        };
        currentDirectory.directories.set(segment, created);
        currentDirectory = created;
      }
      ancestors.push(currentDirectory);
    }

    currentDirectory.files.push({
      kind: "file",
      name: fileName,
      path: filePath,
      stat,
    });

    if (stat) {
      for (const ancestor of ancestors) {
        ancestor.stat.additions += stat.additions;
        ancestor.stat.deletions += stat.deletions;
      }
    }
  }

  return toTreeNodes(root);
}
