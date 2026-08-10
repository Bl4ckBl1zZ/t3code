import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveThreadPreview } from "@t3tools/client-runtime/state/models";
import type { ProviderDriverKind } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MessagesSquareIcon, PlusIcon, RotateCcwIcon, SquarePenIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { useNewThreadHandler, useRememberedNewThreadProjectRef } from "../hooks/useHandleNewThread";
import { useHermesChat } from "../hooks/useHermesChat";
import { useNowMinute } from "../hooks/useNowMinute";
import { useClientSettings } from "../hooks/useSettings";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { isT3WorkBackingProject } from "../t3WorkProject";
import type { SidebarThreadSummary } from "../types";
import { cn } from "../lib/utils";
import {
  selectWorkInboxLandingSections,
  sidebarProviderInstanceKey,
  sortScopedProjectsForSidebar,
} from "./Sidebar.logic";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";

/** How much of the Work inbox the landing shows before deferring to the sidebar. */
const WORK_LANDING_RECENT_LIMIT = 6;

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
    return <HermesUnavailableHero workspaceName="T3 Chat" />;
  }
  return startState.failed ? (
    <DraftStartError
      onRetry={() => {
        setStartState((state) => ({ failed: false, retryRequest: state.retryRequest + 1 }));
      }}
    />
  ) : null;
}

/**
 * T3 Work is an inbox, not a conversation: its threads outlive the session and
 * routinely stop to ask for something. Landing straight in a composer (the way
 * Chat does) would bury whatever is already waiting, so Work opens on the
 * inbox instead — what needs the user, the Main conversation, then what ran
 * most recently — with the composer one click away.
 */
export function WorkInboxLanding() {
  const hermesChat = useHermesChat();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const nowMinute = useNowMinute();
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const [starting, setStarting] = useState(false);

  const providerDriverKindByInstance = useMemo(() => {
    const result = new Map<string, ProviderDriverKind>();
    for (const [environmentId, serverConfig] of serverConfigs) {
      for (const provider of serverConfig.providers) {
        result.set(sidebarProviderInstanceKey(environmentId, provider.instanceId), provider.driver);
      }
    }
    return result;
  }, [serverConfigs]);

  const sections = useMemo(
    () =>
      selectWorkInboxLandingSections({
        threads,
        providerDriverKindByInstance,
        now: `${nowMinute}:00.000Z`,
        autoSettleAfterDays,
        recentLimit: WORK_LANDING_RECENT_LIMIT,
      }),
    [autoSettleAfterDays, nowMinute, providerDriverKindByInstance, threads],
  );

  const startWorkThread = useCallback(() => {
    setStarting(true);
    void hermesChat.start().finally(() => setStarting(false));
  }, [hermesChat]);

  if (!bootstrapped || !hermesChat.isResolved) {
    return null;
  }
  if (!hermesChat.isReady) {
    return <HermesUnavailableHero workspaceName="T3 Work" />;
  }

  const composeButton = (
    <Button size="sm" onClick={startWorkThread} disabled={starting}>
      <SquarePenIcon className="size-4" />
      New work thread
    </Button>
  );

  if (sections.visibleCount === 0) {
    return (
      <WorkLandingShell>
        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <MessagesSquareIcon className="size-5" />
              </div>
              <EmptyTitle className="text-foreground text-2xl sm:text-3xl">
                What are we working on?
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                T3 Work keeps long-running threads that create, learn, and explore — and come back
                to you when they need something.
              </EmptyDescription>
              <div className="mt-6 flex justify-center">{composeButton}</div>
            </EmptyHeader>
          </div>
        </Empty>
      </WorkLandingShell>
    );
  }

  return (
    <WorkLandingShell>
      <div className="mx-auto w-full max-w-2xl px-6 py-10 sm:px-8 sm:py-14">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
            What are we working on?
          </h1>
          {composeButton}
        </div>
        <div className="mt-8 flex flex-col gap-6">
          <WorkLandingSection label="Needs you" threads={sections.needsYou} tone="attention" />
          <WorkLandingSection label="Main" threads={sections.main} />
          <WorkLandingSection label="Recent" threads={sections.recent} />
        </div>
      </div>
    </WorkLandingShell>
  );
}

function WorkLandingShell({ children }: { readonly children: ReactNode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden bg-background">
        {children}
      </div>
    </SidebarInset>
  );
}

function WorkLandingSection(props: {
  readonly label: string;
  readonly threads: readonly SidebarThreadSummary[];
  readonly tone?: "attention";
}) {
  if (props.threads.length === 0) {
    return null;
  }
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={cn(
            "text-xs font-medium",
            props.tone === "attention"
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground/65",
          )}
        >
          {props.label}
        </span>
        <span
          className={cn(
            "h-px flex-1",
            props.tone === "attention" ? "bg-amber-500/20 dark:bg-amber-400/15" : "bg-border/60",
          )}
        />
      </div>
      <ul className="flex flex-col">
        {props.threads.map((thread) => (
          <li key={`${thread.environmentId}:${thread.id}`}>
            <WorkLandingThreadRow thread={thread} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function WorkLandingThreadRow({ thread }: { readonly thread: SidebarThreadSummary }) {
  const preview = resolveThreadPreview(thread);
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;

  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id))}
      className="flex min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{thread.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground/60">
          {formatRelativeTimeLabel(timestamp)}
        </span>
      </span>
      {preview === null ? null : (
        <span className="truncate text-xs text-muted-foreground/70">{preview.text}</span>
      )}
    </Link>
  );
}

export function HermesUnavailableHero({
  workspaceName,
}: {
  readonly workspaceName: "T3 Work" | "T3 Chat";
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">Hermes isn’t ready</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            {workspaceName} conversations run on Hermes. Enable and configure it to start one.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button render={<Link to="/settings/providers" />} size="sm">
              Open provider settings
            </Button>
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
