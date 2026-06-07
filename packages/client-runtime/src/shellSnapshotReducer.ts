import * as Arr from "effect/Array";
import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from "@t3tools/contracts";

/**
 * Apply a single shell stream event to an existing snapshot, returning a new
 * snapshot with the event's changes applied. This is a pure reducer that both
 * web and mobile can use to keep their local shell snapshot in sync.
 *
 * Returns the original snapshot reference unchanged if the event is not
 * recognized (forward-compatible).
 */
export function applyShellStreamEvent(
  snapshot: OrchestrationShellSnapshot,
  event: OrchestrationShellStreamEvent,
): OrchestrationShellSnapshot {
  switch (event.kind) {
    case "project-upserted": {
      const projects = snapshot.projects.some((p) => p.id === event.project.id)
        ? Arr.map(snapshot.projects, (p) => (p.id === event.project.id ? event.project : p))
        : Arr.append(snapshot.projects, event.project);
      return { ...snapshot, projects, snapshotSequence: event.sequence };
    }
    case "project-removed":
      return {
        ...snapshot,
        projects: Arr.filter(snapshot.projects, (p) => p.id !== event.projectId),
        snapshotSequence: event.sequence,
      };
    case "workspace-upserted": {
      const workspaces = snapshot.workspaces ?? [];
      return {
        ...snapshot,
        workspaces: workspaces.some((w) => w.id === event.workspace.id)
          ? Arr.map(workspaces, (w) => (w.id === event.workspace.id ? event.workspace : w))
          : Arr.append(workspaces, event.workspace),
        snapshotSequence: event.sequence,
      };
    }
    case "workspace-removed":
      return {
        ...snapshot,
        workspaces: Arr.filter(snapshot.workspaces ?? [], (w) => w.id !== event.workspaceId),
        snapshotSequence: event.sequence,
      };
    case "workspace-action-upserted": {
      const workspaceActions = snapshot.workspaceActions ?? [];
      return {
        ...snapshot,
        workspaceActions: workspaceActions.some((action) => action.id === event.action.id)
          ? Arr.map(workspaceActions, (action) =>
              action.id === event.action.id ? event.action : action,
            )
          : Arr.append(workspaceActions, event.action),
        snapshotSequence: event.sequence,
      };
    }
    case "workspace-action-removed":
      return {
        ...snapshot,
        workspaceActions: Arr.filter(
          snapshot.workspaceActions ?? [],
          (action) => action.id !== event.actionId,
        ),
        snapshotSequence: event.sequence,
      };
    case "thread-upserted": {
      const threads = snapshot.threads.some((t) => t.id === event.thread.id)
        ? Arr.map(snapshot.threads, (t) => (t.id === event.thread.id ? event.thread : t))
        : Arr.append(snapshot.threads, event.thread);
      return { ...snapshot, threads, snapshotSequence: event.sequence };
    }
    case "sub-chat-upserted": {
      const subChats = snapshot.subChats ?? [];
      return {
        ...snapshot,
        subChats: subChats.some((subChat) => subChat.id === event.subChat.id)
          ? Arr.map(subChats, (subChat) =>
              subChat.id === event.subChat.id ? event.subChat : subChat,
            )
          : Arr.append(subChats, event.subChat),
        snapshotSequence: event.sequence,
      };
    }
    case "sub-chat-removed":
      return {
        ...snapshot,
        subChats: Arr.filter(snapshot.subChats ?? [], (subChat) => subChat.id !== event.subChatId),
        snapshotSequence: event.sequence,
      };
    case "thread-removed":
      return {
        ...snapshot,
        threads: Arr.filter(snapshot.threads, (t) => t.id !== event.threadId),
        snapshotSequence: event.sequence,
      };
    default:
      return snapshot;
  }
}
