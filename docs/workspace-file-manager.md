# Workspace File Manager And Editor

Status: draft implementation spec

## Summary

Add a VS Code-style file and folder manager to T3 Code. Users can browse a
project or worktree, open files, edit supported text files, save changes, and
see external or agent edits without accidentally overwriting them.

The implementation should be a workspace file system and workbench foundation,
not a single React tree component. The design must support:

- local and remote environments
- project roots and per-thread worktrees
- agent edits happening while files are open
- future source-control decorations
- future search, diff, LSP, and external-editor integrations
- future desktop and mobile clients using the same shared state model

## Goals

- Provide an Explorer panel for the active project or worktree.
- Let users open text files in an in-app editor.
- Let users edit and save files with conflict detection.
- Keep file access scoped to the project or worktree root.
- Handle large files, binary files, deleted files, and permission failures as
  explicit UI states.
- Keep directory loading lazy and bounded for large repositories.
- Invalidate and refresh tree/editor state when files change from agents,
  terminals, git operations, or external editors.
- Reuse the existing contracts/server/web/client-runtime split.
- Make the new file APIs useful for future integrations such as prompt context,
  changed-file navigation, project search, git decorations, and LSP.

## Non-Goals

- Building a complete IDE in the first iteration.
- Supporting arbitrary absolute filesystem editing from the browser.
- Implementing collaborative multi-cursor editing.
- Implementing full language-server support in the initial release.
- Persisting every editor tab server-side in the first iteration.
- Replacing the existing command palette path picker.
- Making the in-app editor the only way to edit files. External editor support
  remains useful.

## Existing Context

The repo already has several pieces that should be reused or evolved:

- `packages/contracts/src/filesystem.ts` provides a lightweight path browse
  contract. This is good for path pickers but too narrow for an IDE explorer.
- `packages/contracts/src/project.ts` provides `searchEntries`, `readFile`, and
  `writeFile`. Current file read/write returns only contents and saves blindly.
- `apps/server/src/workspace/Layers/WorkspaceEntries.ts` already has bounded
  indexed workspace entry search with git-ignore filtering.
- `apps/server/src/workspace/Layers/WorkspaceFileSystem.ts` already resolves
  workspace-relative paths safely before reading or writing.
- `packages/client-runtime/src/filesystemBrowseState.ts` demonstrates the
  atom-manager pattern that shared file tree and document state should follow.
- `apps/web/src/threadTabs.ts` is currently chat-thread specific. File tabs
  should use a broader workbench tab model instead of being forced into
  thread-only data.
- `apps/web/src/components/chat/VscodeEntryIcon.tsx` and `apps/web/src/vscode-icons.ts`
  can be reused for explorer icons.

## High-Level Architecture

```text
apps/web
  Explorer panel
  Workbench tab strip
  Monaco editor surface
  Save/conflict UI
       |
       | EnvironmentApi / WsRpcClient
       v
packages/client-runtime
  workspaceTree manager
  workspaceDocument manager
  workbench tab reducer
       |
       | contracts
       v
apps/server
  WorkspaceTree service
  WorkspaceFiles service
  WorkspaceFileWatcher service
  WorkspacePaths safety checks
       |
       v
Project/worktree filesystem
```

The browser always addresses files by `(environmentId, cwd, relativePath)`.
`cwd` is the active project root or thread worktree path. Server code resolves
the relative path inside that root and rejects escapes.

## Contract Model

Add a new contract file:

```text
packages/contracts/src/workspaceFiles.ts
```

Export it from `packages/contracts/src/index.ts`.

Do not put runtime logic in `packages/contracts`; this package remains schema
only.

### Shared Types

```ts
export const WorkspacePathMaxLength = 1024;

export const WorkspaceRootInput = Schema.Struct({
  cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(WorkspacePathMaxLength)),
});

export const WorkspaceRelativePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(WorkspacePathMaxLength),
);

export const WorkspaceFileKind = Schema.Literals(["file", "directory", "symlink", "other"]);
```

### Entry Metadata

```ts
export const WorkspaceEntry = Schema.Struct({
  relativePath: WorkspaceRelativePath,
  name: TrimmedNonEmptyString,
  kind: WorkspaceFileKind,
  parentPath: Schema.optional(WorkspaceRelativePath),
  sizeBytes: Schema.optional(Schema.Number),
  mtimeMs: Schema.optional(Schema.Number),
  readonly: Schema.Boolean,
  hidden: Schema.Boolean,
  ignored: Schema.Boolean,
  symlinkTarget: Schema.optional(Schema.String),
});
```

`ignored` means ignored by source control or built-in ignore rules. Ignored
entries may be hidden by default but can be requested by the UI.

### List Directory

```ts
export const WorkspaceListDirectoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: Schema.optional(Schema.String),
  includeHidden: Schema.optional(Schema.Boolean),
  includeIgnored: Schema.optional(Schema.Boolean),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(5000)),
});

export const WorkspaceListDirectoryResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: Schema.String,
  entries: Schema.Array(WorkspaceEntry),
  truncated: Schema.Boolean,
  scannedAt: Schema.String,
});
```

The server sorts directories before files, then sorts by locale-aware name.
The server must not recursively scan the whole tree for this method.

### Read File

```ts
export const WorkspaceReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: WorkspaceRelativePath,
  maxBytes: Schema.optional(PositiveInt),
});

export const WorkspaceFileVersion = Schema.Struct({
  fingerprint: TrimmedNonEmptyString,
  mtimeMs: Schema.Number,
  sizeBytes: Schema.Number,
});

export const WorkspaceReadFileResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: WorkspaceRelativePath,
  exists: Schema.Boolean,
  contents: Schema.NullOr(Schema.String),
  version: Schema.NullOr(WorkspaceFileVersion),
  encoding: Schema.Literals(["utf8"]),
  eol: Schema.Literals(["lf", "crlf", "mixed", "none"]),
  readonly: Schema.Boolean,
  binary: Schema.Boolean,
  tooLarge: Schema.Boolean,
});
```

`contents` is `null` when the file does not exist, is binary, or is too large
for the configured editor limit.

### Write File

```ts
export const WorkspaceWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: WorkspaceRelativePath,
  contents: Schema.String,
  expectedVersion: Schema.NullOr(WorkspaceFileVersion),
  create: Schema.optional(Schema.Boolean),
  overwriteReadonly: Schema.optional(Schema.Boolean),
});

export const WorkspaceWriteFileResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: WorkspaceRelativePath,
  version: WorkspaceFileVersion,
  writtenAt: Schema.String,
});
```

`expectedVersion` is required for normal saves. Passing `null` means "I expect
this file not to exist." If the current version differs, the server returns a
conflict error.

### Mutations

Add explicit mutation APIs instead of overloading write:

```ts
workspaceFiles.createDirectory(input);
workspaceFiles.createFile(input);
workspaceFiles.rename(input);
workspaceFiles.delete(input);
```

`delete` should support files and empty directories initially. Recursive delete
can be added later with a separate explicit flag and confirmation UI.

### Watch Stream

```ts
export const WorkspaceWatchInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});

export const WorkspaceFileChangeKind = Schema.Literals([
  "created",
  "updated",
  "deleted",
  "renamed",
  "unknown",
]);

export const WorkspaceFileChangeEvent = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: WorkspaceRelativePath,
  kind: WorkspaceFileChangeKind,
  directoryPath: Schema.String,
  observedAt: Schema.String,
});
```

Watch events are invalidation hints, not authoritative state. The client should
refresh affected directories and open documents after receiving them.

## RPC Surface

Add WebSocket methods in `packages/contracts/src/rpc.ts`:

```ts
workspaceFiles.listDirectory;
workspaceFiles.readFile;
workspaceFiles.writeFile;
workspaceFiles.createFile;
workspaceFiles.createDirectory;
workspaceFiles.rename;
workspaceFiles.delete;
workspaceFiles.subscribeChanges;
```

Add methods to `EnvironmentApi` and `WsRpcClient`.

Keep existing `projects.readFile` and `projects.writeFile` for compatibility
with current features such as saving proposed plans. New editor code should use
`workspaceFiles`.

## Server Services

Add or evolve services under:

```text
apps/server/src/workspace/Services
apps/server/src/workspace/Layers
```

### WorkspaceTree

Responsibilities:

- list one directory at a time
- return entry metadata
- apply built-in ignore rules
- apply VCS ignore filtering when available
- sort entries consistently
- handle permission errors as typed failures
- keep work bounded with limits and no recursive listing

This can reuse portions of `WorkspaceEntries`, but it should not depend on the
global workspace search index for directory listing. Tree listing needs fresh
directory state and metadata for a single directory.

### WorkspaceFiles

Responsibilities:

- read text files with size and binary checks
- preserve newline style where practical
- return version metadata
- write with optimistic concurrency
- create parent directories only when the operation explicitly allows it
- reject path escapes and unsafe symlink escapes
- invalidate `WorkspaceEntries` caches after mutations
- emit or trigger file-change invalidation events after mutations

Version fingerprint should be deterministic and cheap:

```ts
fingerprint = `${mtimeMs}:${sizeBytes}:${sha256(contents)}`;
```

For large files, avoid hashing the full file on every directory listing. Hash
only on read/write where conflict detection matters.

### WorkspaceFileWatcher

Responsibilities:

- maintain one ref-counted watcher per `(environment connection, cwd)`
- coalesce noisy `fs.watch` events
- map absolute paths back to workspace-relative paths
- reject events outside the workspace root
- notify connected clients via stream
- fall back to polling or manual refresh if watching fails

The watcher should be best effort. Correctness comes from fresh reads and
version checks, not from assuming every watch event is delivered.

### Symlink Policy

Initial policy:

- show symlinks in the tree
- allow opening a symlink only if its realpath resolves inside `cwd`
- reject writes through symlinks that resolve outside `cwd`
- show a clear unsupported or unsafe-link error for outside-root links

This keeps browser file access constrained even when repositories contain
symlinks.

### Large And Binary Files

Recommended defaults:

- editor text file limit: 2 MiB
- preview metadata limit: no content read for files above limit
- binary detection: first 8 KiB contains NUL byte or failed UTF-8 decode

The result should distinguish:

- `binary: true`
- `tooLarge: true`
- `readonly: true`
- `exists: false`

The UI can then render precise states.

## Client Runtime

Add shared client managers under:

```text
packages/client-runtime/src/workspaceTreeState.ts
packages/client-runtime/src/workspaceDocumentState.ts
packages/client-runtime/src/workbenchTabsState.ts
```

Export them from `packages/client-runtime/src/index.ts`.

### Workspace Tree Manager

State key:

```ts
type WorkspaceTreeTarget = {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
};
```

State:

```ts
type WorkspaceTreeDirectoryState = {
  data: WorkspaceListDirectoryResult | null;
  error: string | null;
  isPending: boolean;
  lastLoadedAt: number | null;
};
```

Responsibilities:

- lazy-load directories when expanded
- reuse fresh cached results
- track pending and error states per directory
- refresh affected directories after watcher events
- invalidate old cwd entries when project/worktree changes
- support optimistic updates after create, rename, and delete
- expose deterministic selectors for UI tests

Use the same ref-counted watch and stale-time style already used by
`createFilesystemBrowseManager`.

### Workspace Document Manager

State key:

```ts
type WorkspaceDocumentTarget = {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
};
```

State:

```ts
type WorkspaceDocumentState = {
  status:
    | "idle"
    | "loading"
    | "ready"
    | "saving"
    | "conflict"
    | "deleted"
    | "unsupported"
    | "error";
  serverContents: string | null;
  draftContents: string | null;
  version: WorkspaceFileVersion | null;
  error: string | null;
  dirty: boolean;
  readonly: boolean;
  binary: boolean;
  tooLarge: boolean;
  externalChange: boolean;
};
```

Responsibilities:

- load files by target
- track dirty drafts
- save with `expectedVersion`
- surface conflicts without discarding user edits
- mark open documents changed when watch events arrive
- allow reload, revert, overwrite, and save-as-new workflows
- retain recently closed documents briefly for fast tab reopen

Conflict behavior:

1. User opens file with version `A`.
2. User edits locally.
3. Agent or external editor writes version `B`.
4. User saves with expected version `A`.
5. Server returns conflict with current version `B`.
6. UI keeps draft contents and offers:
   - compare
   - reload from disk
   - overwrite disk
   - cancel

### Workbench Tabs

Introduce a general tab model:

```ts
type WorkbenchTab =
  | {
      kind: "chat";
      id: string;
      threadRef: ScopedThreadRef;
      title: string;
      dirty: false;
    }
  | {
      kind: "file";
      id: string;
      environmentId: EnvironmentId;
      cwd: string;
      relativePath: string;
      title: string;
      dirty: boolean;
    }
  | {
      kind: "diff";
      id: string;
      environmentId: EnvironmentId;
      cwd: string;
      relativePath?: string;
      title: string;
      dirty: false;
    }
  | {
      kind: "terminal";
      id: string;
      environmentId: EnvironmentId;
      cwd: string;
      terminalId: string;
      title: string;
      dirty: false;
    };
```

Initial persistence can be local-client only:

- active sidebar panel
- expanded directories per `(environmentId, cwd)`
- open file tabs
- active tab
- editor layout preferences

Do not store unsaved file contents in local storage initially. It creates
privacy, size, and stale-write problems. A later draft recovery feature can be
added intentionally.

## Web UI

### Sidebar

Evolve the left app sidebar into a workbench sidebar with switchable panels:

- Threads
- Explorer
- Source Control later
- Search later

The Explorer panel should show the active project/worktree. If there is no
active project, show an empty state with no filesystem calls.

Explorer requirements:

- lazy-load root directory on mount
- expand/collapse directories
- click file to open tab
- keep selected file highlighted
- show loading/error states per directory
- support refresh directory
- support create file
- support create folder
- support rename
- support delete file
- support reveal active file
- hide ignored and hidden files by default, with panel-level toggles
- show file icons with existing VS Code icon helper
- support keyboard navigation basics:
  - arrow up/down moves selection
  - arrow right expands or opens directory
  - arrow left collapses or selects parent
  - enter opens file
  - escape cancels inline create/rename

Use virtualized rendering once flattened visible rows can exceed a few hundred
items. The tree row height should be fixed.

### Editor

Use Monaco Editor, lazy-loaded only when the first file opens.

Requirements:

- open one editor per file tab
- infer Monaco language from filename/extension
- show dirty indicator in tab
- save with `Cmd/Ctrl + S`
- revert file
- reload from disk
- close tab with dirty confirmation
- render read-only state for readonly, binary, too-large, or unsupported files
- preserve scroll/cursor state while tab remains open
- show external-change indicator when file changes on disk
- show conflict state if save is rejected by version mismatch

Editor header actions:

- Save
- Revert
- Reload
- Open externally
- Copy relative path
- Reveal in Explorer

### Workbench Layout

The central content area should support mixed tabs:

- chat thread
- file editor
- diff view
- terminal view later

The current thread tab strip should be generalized rather than duplicated. The
first implementation can keep chat rendering as-is and add file tabs beside it
through an adapter, but the target model is `WorkbenchTab`.

### Mobile

The first implementation can be web-only, but shared state should live in
`packages/client-runtime`. Mobile can later use:

- file search
- read-only preview
- simple text editor
- open changed files from diffs

Do not put core state transitions only in `apps/web`.

## Integrations

### Agent Context

Future composer integrations should be able to add files from the Explorer:

- right-click file -> Add to prompt
- drag file into composer
- copy `@path` reference
- open file mentioned in assistant output

This should call existing or future composer path context APIs, not special-case
the Explorer.

### Diffs

Changed-file lists should be able to open a file tab or diff tab:

- click changed file -> open diff focused to file
- alternate action -> open current file
- reveal changed file in Explorer

### Source Control

Explorer rows should eventually show decorations:

- modified
- added
- deleted
- renamed
- ignored
- conflict

Do not bake git-specific fields directly into `WorkspaceEntry`. Instead expose
source-control decorations through a separate client state keyed by relative
path, then join in the UI.

### Language Services

Monaco enables future language support, but LSP should be a separate backend
capability:

- one LSP process per workspace/language when needed
- server mediates file access and lifecycle
- client sends document open/change/close events
- diagnostics stream back as decorations

Do not block the initial file manager on LSP.

## Security And Safety

Security invariants:

- All editor APIs are workspace-root scoped.
- Browser clients never send arbitrary absolute paths for file edits.
- Server resolves and validates every path.
- Path traversal using `..` is rejected after normalization.
- Symlinks outside root are not editable.
- Writes use optimistic concurrency.
- Delete and recursive operations require explicit APIs and UI confirmation.
- Binary and large files are not loaded into Monaco.
- Error messages should be useful but should not leak unrelated server paths
  beyond the selected workspace root.

Remote environment note:

The browser may be on a different machine from the server. File operations must
always happen on the environment/server that owns the project. The UI should not
use browser-local filesystem APIs.

## Performance Requirements

- Listing one directory should not recursively scan the repository.
- Search can continue using the existing bounded workspace index.
- Directory listing should be capped and report `truncated`.
- Watch events must be debounced and coalesced.
- Monaco must be lazy-loaded and code-split.
- Large files must avoid full-content reads unless explicitly allowed.
- The tree must avoid re-rendering every row when one directory loads.
- Directory state should be keyed and cached independently.
- Explorer should remain usable with repositories containing tens of thousands
  of files.

## Error States

The UI should distinguish:

- directory not found
- file not found
- permission denied
- outside workspace root
- symlink outside workspace root
- binary file
- file too large
- readonly file
- save conflict
- file deleted while open
- watcher unavailable
- environment disconnected

These states should map from typed server errors where practical.

## Testing Strategy

### Contracts

- schema decode/encode for all new inputs and results
- path length limits
- optional fields compatibility
- tagged error shape

### Server Unit Tests

Add tests under `apps/server/src/workspace/Layers`.

Coverage:

- list directory returns sorted metadata
- hidden and ignored toggles work
- list limit truncates
- read text file returns contents and version
- read missing file returns `exists: false`
- binary file is detected
- too-large file is not loaded
- write succeeds with matching version
- write fails with stale version
- write with `expectedVersion: null` fails if file exists
- path traversal is rejected
- symlink outside root is rejected
- rename invalidates directory state
- delete invalidates directory state

### Client Runtime Tests

Add tests under `packages/client-runtime/src`.

Coverage:

- directory manager dedupes in-flight loads
- directory manager caches fresh entries
- invalidation refreshes watched directories
- optimistic create/rename/delete updates state
- document manager tracks dirty state
- document save updates server version
- conflict keeps local draft
- external-change event marks open clean document stale
- external-change event does not discard dirty draft
- reset clears environment state

### Web Tests

Use component/unit tests for logic-heavy parts:

- flatten tree rows from expanded directories
- keyboard navigation
- dirty tab close behavior
- conflict action reducer
- active file reveal path expansion

Browser tests can be added after the first UI implementation:

- open Explorer
- expand folder
- open file
- edit and save
- simulate stale save conflict
- create and rename file

### Required Checks

Before considering implementation complete:

```bash
bun fmt
bun lint
bun typecheck
```

If native mobile code changes:

```bash
bun lint:mobile
```

Do not run `bun test`; use `bun run test` for Vitest when tests are needed.

## Rollout Plan

### Phase 1: Backend Contracts And Safe File Operations

- add `workspaceFiles` contracts
- add RPC methods
- implement `WorkspaceFiles.readFile`
- implement `WorkspaceFiles.writeFile` with version checks
- preserve existing project read/write compatibility
- add server tests for reads, writes, conflicts, and path safety

Deliverable: file content can be safely read/written from web RPC without UI.

### Phase 2: Directory Tree API

- implement `WorkspaceTree.listDirectory`
- add metadata and ignore handling
- add truncation
- add tests for listing behavior

Deliverable: Explorer can lazily render real directory contents.

### Phase 3: Client Runtime State

- add workspace tree manager
- add workspace document manager
- add workbench tab reducer
- add tests for state transitions

Deliverable: UI can consume shared state without local ad hoc fetch logic.

### Phase 4: Explorer UI

- add sidebar panel switcher
- add Explorer panel
- render root and lazy expanded directories
- support file open, refresh, create file/folder, rename, delete
- add basic keyboard navigation

Deliverable: users can browse and manage files.

### Phase 5: Editor UI

- add lazy Monaco dependency and editor surface
- add file tabs
- implement save/revert/reload
- implement dirty close confirmation
- implement binary/large/readonly unsupported states

Deliverable: users can edit text files safely.

### Phase 6: Watch And Conflict UX

- add workspace watch stream
- invalidate tree directories on change
- mark open documents externally changed
- add conflict compare/reload/overwrite UI

Deliverable: agent and external edits are visible and do not cause silent
overwrites.

### Phase 7: Integrations

- reveal changed files from diffs
- open files mentioned in markdown output
- add files to prompt context
- add source-control decorations
- add file search panel

Deliverable: Explorer becomes part of the broader coding-agent workflow.

## Implementation Notes

- Prefer Effect services on the server, matching existing workspace services.
- Keep new schemas backward-compatible where possible.
- Prefer explicit subpath exports in shared packages.
- Avoid broad app state additions in `apps/web/src/store.ts` unless the state is
  truly web-only. Shared behavior belongs in `packages/client-runtime`.
- Use existing toast patterns for success/failure messages.
- Use existing `EnvironmentApi` plumbing rather than direct WebSocket calls from
  components.
- Keep UI controls dense and work-focused. This is an operational tool, not a
  landing page.

## Open Questions

- Should file tabs persist across browser reloads in the first release?
- Should unsaved drafts be recoverable after reload, or is that a later feature?
- What should the first text-file size limit be for hosted/remote environments?
- Should initial delete support directories at all, or only files?
- Should symlink editing be disabled entirely in the first release?
- Should conflict compare use the existing diff panel or a Monaco diff editor?
- Should hidden and ignored file toggles be global settings or per-workspace UI
  state?

## Acceptance Criteria

- A user can switch to Explorer for the active project/worktree.
- A user can expand folders without scanning the entire repo.
- A user can open a text file in an in-app editor.
- A user can edit and save a text file.
- Saving fails safely when the file changed on disk since it was opened.
- The UI keeps the user's unsaved draft after a conflict.
- Binary and oversized files do not load into the editor.
- Path traversal and outside-root symlink writes are rejected server-side.
- Directory changes made by the app invalidate the Explorer.
- Required repo checks pass.
