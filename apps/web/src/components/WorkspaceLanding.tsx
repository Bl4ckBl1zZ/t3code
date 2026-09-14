import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { PlusIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { useNewThreadHandler, useRememberedNewThreadProjectRef } from "../hooks/useHandleNewThread";
import { HermesSetup } from "./HermesSetup";
import { useWorkEnvironment } from "../hooks/useWorkEnvironment";
import { useHermesConnection } from "../hooks/useHermesConnection";
import { useHermesChat } from "../hooks/useHermesChat";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../state/entities";
import { isT3WorkBackingProject } from "../t3WorkProject";
import { sortScopedProjectsForSidebar } from "./Sidebar.logic";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";

/**
 * Landing on the index route drops straight into a draft thread for the
 * project the user last started a thread in (most recently active project when
 * nothing is remembered yet), so the first screen is a prompt instead of a dead
 * end. Falls back to an add-project hero when no project exists yet.
 */
export function CodeDraftLanding() {
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const rememberedProjectRef = useRememberedNewThreadProjectRef();
  const startingRef = useRef(false);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  // The index draft is the Code composer; the T3 Work backing project is
  // Hermes-only, so it must never be the auto-selected draft target.
  const codeProjects = useMemo(
    () => projects.filter((project) => !isT3WorkBackingProject(project, serverConfigs)),
    [projects, serverConfigs],
  );
  // Picking up where the user left off beats recency: they may have opened a
  // handful of older threads since, which would otherwise reshuffle the
  // landing target under them.
  const landingProject = useMemo(() => {
    if (!bootstrapped) {
      return null;
    }
    const remembered = rememberedProjectRef
      ? codeProjects.find(
          (project) =>
            project.id === rememberedProjectRef.projectId &&
            project.environmentId === rememberedProjectRef.environmentId,
        )
      : undefined;
    return (
      remembered ?? sortScopedProjectsForSidebar(codeProjects, threads, "updated_at")[0] ?? null
    );
  }, [bootstrapped, codeProjects, rememberedProjectRef, threads]);

  useEffect(() => {
    if (landingProject === null || startingRef.current) {
      return;
    }
    // Until the environment's server config arrives, the Work-backing check
    // above cannot classify this project; starting the draft now could latch
    // onto the T3 Work project. The effect re-runs once configs load.
    if (!serverConfigs.has(landingProject.environmentId)) {
      return;
    }
    startingRef.current = true;
    void handleNewThread(scopeProjectRef(landingProject.environmentId, landingProject.id), {
      replace: true,
    }).catch(() => {
      startingRef.current = false;
      setStartState((state) => ({ ...state, failed: true }));
    });
  }, [handleNewThread, landingProject, serverConfigs, startState.retryRequest]);

  if (!bootstrapped) {
    return null;
  }
  if (landingProject !== null) {
    return startState.failed ? (
      <DraftStartError
        onRetry={() => {
          setStartState((state) => ({
            failed: false,
            retryRequest: state.retryRequest + 1,
          }));
        }}
      />
    ) : null;
  }
  return <NoProjectsHero />;
}

/**
 * T3 Chat is a conversation surface, so its landing is the composer itself:
 * a fresh Hermes draft on the T3 Work backing project, which is created on
 * demand the first time either Hermes workspace is used.
 */
export function ChatComposerLanding() {
  return <HermesComposerLanding workspaceName="T3 Chat" />;
}

function HermesComposerLanding({
  workspaceName,
}: {
  readonly workspaceName: "T3 Work" | "T3 Chat";
}) {
  const hermesChat = useHermesChat();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const startingRef = useRef(false);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  useEffect(() => {
    // Readiness before the primary environment's config lands is "unknown",
    // not "unavailable" — starting then would fail a boot that only needed
    // another tick. The effect re-runs once the config resolves.
    if (!bootstrapped || !hermesChat.isResolved || !hermesChat.isReady || startingRef.current) {
      return;
    }
    startingRef.current = true;
    void hermesChat
      .start({ replace: true })
      .then((outcome) => {
        if (outcome === "started") return;
        startingRef.current = false;
        setStartState((state) => ({ ...state, failed: true }));
      })
      .catch(() => {
        startingRef.current = false;
        setStartState((state) => ({ ...state, failed: true }));
      });
  }, [bootstrapped, hermesChat, startState.retryRequest]);

  if (!bootstrapped || !hermesChat.isResolved) {
    return null;
  }
  if (!hermesChat.isReady) {
    return <HermesUnavailableHero workspaceName={workspaceName} />;
  }
  return startState.failed ? (
    <DraftStartError
      onRetry={() => {
        setStartState((state) => ({ failed: false, retryRequest: state.retryRequest + 1 }));
      }}
    />
  ) : null;
}

/** Work opens the same conversation surface, with one native session per thread. */
export function WorkComposerLanding() {
  return <HermesComposerLanding workspaceName="T3 Work" />;
}

export function HermesUnavailableHero({
  workspaceName,
}: {
  readonly workspaceName: "T3 Work" | "T3 Chat";
}) {
  const environment = useWorkEnvironment();
  const [connectionId] = useHermesConnection(environment?.environmentId ?? null);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">Set up Hermes</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            {workspaceName} uses Hermes for each thread. Set it up once to start conversations.
          </EmptyDescription>
          <div className="mt-5 grid justify-center gap-3">
            {environment ? (
              <HermesSetup
                key={`${environment.environmentId}:${connectionId}`}
                environmentId={environment.environmentId}
                environmentLabel={environment.label}
                providerInstanceId={connectionId ?? "hermes"}
              />
            ) : null}
            <Link to="/settings/providers" className="text-xs text-muted-foreground underline">
              Advanced connection settings
            </Link>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">Couldn’t start a new thread</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            The project is still available. Try opening the draft again.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RotateCcwIcon className="size-4" />
              Try again
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

function NoProjectsHero() {
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-2xl sm:text-3xl">
                What should we work on?
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                Add a project to start your first thread.
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button size="sm" onClick={openAddProject}>
                  <PlusIcon className="size-4" />
                  Add project
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
