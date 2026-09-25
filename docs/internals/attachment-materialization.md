# Attachment materialization

> For maintainers. Using T3 Code? See [docs/user/attachments.md](../user/attachments.md).

Chat uploads are written into the agent's working directory and named in the turn prompt, instead
of being base64-inlined into every turn.

## Why

Every provider adapter used to re-read the blob store and re-encode attachments into its own turn
payload. That had three costs:

- Non-image files barely worked. `ClaudeAdapterV2` failed the whole turn on a non-image MIME type,
  and `AcpAdapterV2` shipped a PDF's bytes as an `image` content block. Only Hermes handled PDFs.
  Web hid this by refusing non-image files unless the provider was Hermes; mobile did not, so a
  mobile user on Claude could attach a PDF that blew up server-side.
- A 10 MB screenshot is ~13M characters of base64 re-sent on the turn.
- The agent saw pixels, not a path, so it could not grep a CSV or refer back to the file later.

## Layout

```
<cwd>/.t3code/vcs.json                            # pre-existing, untouched
<cwd>/.t3code/uploads/.gitignore                  # a bare "*", so it hides itself too
<cwd>/.t3code/uploads/<thread8>/<attach8>-<name>
```

`cwd` is the agent's working directory: `thread.worktreePath ?? project.workspaceRoot`.

`thread8` is `sha256(threadId)` truncated to 8 hex; a raw `ThreadId` sanitizes to a ~117-character
directory name. `attach8` reuses the UUID half of the attachment id, which
`createDeterministicAttachmentId` already derives from `(threadId, "<messageId>:<index>")`. That
makes the whole path deterministic — a resend, steer, restart, or session resume recomputes it and
finds the file already there — and makes two files named `spec.pdf` in one message impossible to
collide. The hex prefix also neutralizes leading dots, `..`, Windows reserved names, and
case-insensitive filesystems.

Filename sanitization lives in `apps/server/src/attachments/uploadPaths.ts` and is pure, so the
rules are pinned by a table test rather than discovered from a corrupted filesystem.

## The gitignore is load-bearing

`GitVcsDriver.captureCheckpoint` builds its tree with `git add -A -- .`, which honors gitignore, so
the ignore file keeps uploads out of every checkpoint — **but only if it is written before the first
blob**. `AttachmentMaterialization` guarantees that ordering, and
`AttachmentMaterializationGitignore.test.ts` pins it.

Restore runs `git clean -fd` without `-x`, so ignored uploads survive a rollback and paths named in
earlier turns stay valid.

Scoped to `uploads/` deliberately: `.t3code/vcs.json` is legitimately committed, and a repo may own
its own `.t3code/.gitignore`. The project's root `.gitignore` is never touched — it is a tracked
file, and dirtying it is the exact failure this avoids. `.git/info/exclude` is also avoided: it is
invisible to the user, does not survive a clone, and for linked worktrees Git resolves it against
the common dir, so one worktree's write would leak into the user's main checkout.

## Delivery policy

`resolveAttachmentDelivery(driver, attachment)` in
`apps/server/src/attachments/AttachmentMaterialization.ts` is the single place this is decided:

| Case                                                          | Delivery                                                |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| Image on a local-filesystem driver                            | `both` — written to disk **and** sent as a vision block |
| Any other file on a local-filesystem driver                   | `workspace`                                             |
| Anything on Hermes                                            | `inline`                                                |
| Preview annotation screenshots (`role: "preview-annotation"`) | `inline`                                                |

Images are `both` so the agent sees a screenshot immediately and still gets a stable path it can
cite later or hand to a tool. Image context cost is unchanged from before — it was already inline;
the savings come from the non-image files, which did not work at all.

Hermes is carved out because `HermesConnectionSecurity` supports remote gateways, and a file in the
server's worktree is invisible to an agent on another host. Hermes already accepts every file type
inline, so it loses nothing.

This is driver-level _policy_, deliberately not the same thing as an adapter's runtime image
capability. ACP negotiates image support per session, so an ACP agent that did not negotiate images
still gets `both`, skips the inline block inside the adapter, and falls back to the path.

## Degradation, not failure

`AttachmentMaterialization.materialize` has error type `never`. No cwd, an unwritable tree, a
`.t3code` that is a file, a blob the GC already removed — each degrades that attachment to the
previous inline behavior. This makes the change a strict superset of what shipped before: no
regression is structurally possible, and a turn can never die because a disk write lost.

`outcome` distinguishes `skipped` from `failed`, and the difference matters in the UI. A
projectless conversation is `skipped` and renders exactly as it did before; collapsing the two would
put a permanent warning in front of every user who never had a workspace.

## Wiring

Two call sites, both places where the turn message and the runtime policy's `cwd` are in hand:

- `ProviderTurnStartService` — the normal turn path. Also emits `message.updated` with each
  attachment's `workspacePath`, which is what the client renders under the message bubble.
- `ProviderTurnControlService.steer` — steering messages carry attachments too and reach the adapter
  by a different route, so they materialize independently. This is why that layer gained
  `RuntimePolicyV2`.

Everything else that carries attachments (`ThreadLaunchService`, `ThreadManagementService`) routes
through `message.dispatch` and therefore through `ProviderTurnStartService`. The text-generation
paths (thread titles, branch names) are one-shot models with no file tools and no guaranteed cwd, so
they keep reading the blob store directly — one of three reasons the blob store stays exactly as it
is. The other two are message-bubble thumbnails (`AssetAccess`) and the inline fallback.

## Client rules

`packages/shared/src/composerAttachments.ts` owns validation for every surface. Web and mobile each
had their own copy and had already drifted. Three rejections survive: unusable name, empty file,
over cap. Audio, archives, executables, and extensionless blobs are all accepted — the provider no
longer constrains what a user may attach, so `composerAttachmentAccept` is gone.
