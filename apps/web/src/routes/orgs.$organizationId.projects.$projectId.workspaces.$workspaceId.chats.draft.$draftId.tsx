import { createFileRoute } from "@tanstack/react-router";

import {
  requireAuthenticatedChatRoute,
  useWorkspaceDraftRouteRedirect,
} from "../workspaceChatRoutes";
import type { DraftId } from "../composerDraftStore";

function WorkspaceDraftChatRouteView() {
  const params = Route.useParams();
  useWorkspaceDraftRouteRedirect({ draftId: params.draftId as DraftId });
  return null;
}

export const Route = createFileRoute(
  "/orgs/$organizationId/projects/$projectId/workspaces/$workspaceId/chats/draft/$draftId",
)({
  beforeLoad: ({ context }) => requireAuthenticatedChatRoute(context),
  component: WorkspaceDraftChatRouteView,
});
