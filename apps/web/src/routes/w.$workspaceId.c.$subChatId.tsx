import { createFileRoute } from "@tanstack/react-router";

import { SubChatId, WorkspaceId } from "@t3tools/contracts";
import {
  requireAuthenticatedChatRoute,
  useWorkspaceChatRouteRedirect,
} from "../workspaceChatRoutes";

function ShortWorkspaceChatRouteView() {
  const params = Route.useParams();
  useWorkspaceChatRouteRedirect({
    workspaceId: WorkspaceId.make(params.workspaceId),
    subChatId: SubChatId.make(params.subChatId),
  });
  return null;
}

export const Route = createFileRoute("/w/$workspaceId/c/$subChatId")({
  beforeLoad: ({ context }) => requireAuthenticatedChatRoute(context),
  component: ShortWorkspaceChatRouteView,
});
