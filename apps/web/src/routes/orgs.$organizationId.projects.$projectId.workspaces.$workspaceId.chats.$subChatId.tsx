import { createFileRoute } from "@tanstack/react-router";

import { OrganizationId, ProjectId, SubChatId, WorkspaceId } from "@t3tools/contracts";
import {
  requireAuthenticatedChatRoute,
  useWorkspaceChatRouteRedirect,
} from "../workspaceChatRoutes";

function FullWorkspaceChatRouteView() {
  const params = Route.useParams();
  useWorkspaceChatRouteRedirect({
    organizationId: OrganizationId.make(params.organizationId),
    projectId: ProjectId.make(params.projectId),
    workspaceId: WorkspaceId.make(params.workspaceId),
    subChatId: SubChatId.make(params.subChatId),
  });
  return null;
}

export const Route = createFileRoute(
  "/orgs/$organizationId/projects/$projectId/workspaces/$workspaceId/chats/$subChatId",
)({
  beforeLoad: ({ context }) => requireAuthenticatedChatRoute(context),
  component: FullWorkspaceChatRouteView,
});
