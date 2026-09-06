import { createFileRoute, Link } from "@tanstack/react-router";
import { LinkIcon, PlusIcon } from "lucide-react";

import { workspaceLandingKind } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import {
  ChatComposerLanding,
  CodeDraftLanding,
  WorkInboxLanding,
} from "../components/WorkspaceLanding";
import { useEnvironments } from "../state/environments";
import { APP_DISPLAY_NAME } from "~/branding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useSidebarWorkspace } from "~/sidebarWorkspace";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments } = useEnvironments();
  const [workspace] = useSidebarWorkspace();

  if (authGateState.status === "hosted-static" && environments.length === 0) {
    return <HostedStaticOnboardingState />;
  }

  // The index route is the landing for every workspace, so it has to open on
  // the side the user is actually in: dropping T3 Work or T3 Chat into the
  // Code composer offers a coding thread their own sidebar cannot list.
  switch (workspaceLandingKind(workspace)) {
    case "work-inbox":
      return <WorkInboxLanding />;
    case "chat-composer":
      return <ChatComposerLanding />;
    case "code-composer":
      return <CodeDraftLanding />;
  }
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

function HostedStaticOnboardingState() {
  const cloudEnabled = hasCloudPublicConfig();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader className="border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </WorkspacePageHeader>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle className="text-foreground text-xl">
                Connect to a computer running T3 Code
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                This browser connects to T3 Code running on your computer or a server. Start the T3
                Code desktop app or command-line server on that machine and keep it running.
              </EmptyDescription>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                {cloudEnabled
                  ? "Enable T3 Connect on that machine, then open Connections here to sign in with the same account. You can also add the machine using a pairing link."
                  : "Open Connections and add that machine using its pairing link. This browser must be able to reach it."}
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button render={<Link to="/settings/connections" />} size="sm">
                  <PlusIcon className="size-4" />
                  Open Connections
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
