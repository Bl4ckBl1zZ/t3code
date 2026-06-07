import { redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime";
import {
  EnvironmentId,
  type OrganizationId,
  type ProjectId,
  type ScopedThreadRef,
  type SubChatId,
  type WorkspaceId,
} from "@t3tools/contracts";
import type { DraftId } from "./composerDraftStore";
import { selectEnvironmentState, useStore, type AppState } from "./store";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "./threadRoutes";

export function requireAuthenticatedChatRoute(context: {
  readonly authGateState: { readonly status: string };
}) {
  if (
    context.authGateState.status !== "authenticated" &&
    context.authGateState.status !== "hosted-static"
  ) {
    throw redirect({ to: "/pair", replace: true });
  }
}

export function resolveWorkspaceChatRouteRef(
  state: AppState,
  input: {
    readonly organizationId?: OrganizationId | undefined;
    readonly projectId?: ProjectId | undefined;
    readonly workspaceId: WorkspaceId;
    readonly subChatId: SubChatId;
  },
): ScopedThreadRef | null {
  for (const environmentIdValue of Object.keys(state.environmentStateById)) {
    const environmentId = EnvironmentId.make(environmentIdValue);
    const environmentState = selectEnvironmentState(state, environmentId);
    const workspace = environmentState.workspaceById[input.workspaceId];
    const subChat = environmentState.subChatShellById[input.subChatId];
    if (!workspace || !subChat) {
      continue;
    }
    if (workspace.id !== subChat.workspaceId || input.workspaceId !== subChat.workspaceId) {
      continue;
    }
    if (input.projectId !== undefined && workspace.projectId !== input.projectId) {
      continue;
    }
    if (input.organizationId !== undefined && workspace.organizationId !== input.organizationId) {
      continue;
    }
    return scopeThreadRef(environmentId, input.subChatId);
  }

  return null;
}

export function useWorkspaceChatRouteRedirect(input: {
  readonly organizationId?: OrganizationId | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly workspaceId: WorkspaceId;
  readonly subChatId: SubChatId;
}) {
  const navigate = useNavigate();
  const routeRef = useStore(
    useMemo(
      () => (state: AppState) => resolveWorkspaceChatRouteRef(state, input),
      [input.organizationId, input.projectId, input.subChatId, input.workspaceId],
    ),
  );
  const bootstrapComplete = useStore((state) =>
    Object.values(state.environmentStateById).some(
      (environmentState) => environmentState.bootstrapComplete,
    ),
  );

  useEffect(() => {
    if (routeRef) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(routeRef),
        replace: true,
      });
      return;
    }
    if (bootstrapComplete) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, navigate, routeRef]);
}

export function useWorkspaceDraftRouteRedirect(input: { readonly draftId: DraftId }) {
  const navigate = useNavigate();

  useEffect(() => {
    void navigate({
      to: "/draft/$draftId",
      params: buildDraftThreadRouteParams(input.draftId),
      replace: true,
    });
  }, [input.draftId, navigate]);
}
