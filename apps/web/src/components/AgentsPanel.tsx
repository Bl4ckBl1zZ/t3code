/**
 * Agents surface: the roster of delegated agents and background work for a
 * thread, with workflow progress and run handles.
 *
 * Reads the v2 projection's `subagents` directly. There is no separate client
 * fold because v2 subagents are real threads with real lifecycle rows -- the
 * roster is the projection, not a reconstruction of it.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Bot, ExternalLink, FileCode2, Loader2, TerminalSquare } from "lucide-react";
import { memo, useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { AgentOrb } from "./chat/AgentOrb";
import { ScrollArea } from "./ui/scroll-area";
import { Badge } from "./ui/badge";
import { cn } from "~/lib/utils";
import { useThreadProjection } from "../state/entities";
import {
  buildAgentsPanelModel,
  formatTokenCount,
  workflowPhaseProgress,
  type AgentRow,
} from "./agentsPanel.logic";
import { WorkflowScriptDialog } from "./WorkflowScriptDialog";

function UsageSummary({ row }: { row: AgentRow }) {
  const usage = row.usage;
  if (usage === undefined) return null;
  return (
    <span className="tabular-nums text-muted-foreground/70">
      {formatTokenCount(usage.totalTokens)} tok
      {usage.toolUses !== undefined ? ` · ${usage.toolUses} tools` : null}
    </span>
  );
}

function WorkflowProgress({ row }: { row: AgentRow }) {
  const workflow = row.workflow;
  const progress = workflowPhaseProgress(workflow);
  if (workflow === undefined || progress === null) return null;
  return (
    <div className="mt-1 flex items-center gap-1.5">
      <span className="text-[11px] tabular-nums text-muted-foreground/70">
        {progress.current}/{progress.total}
      </span>
      {/* Phase pips: cheaper to scan than a label per phase, and they still
          show shape (how far along, how many total) at a glance. */}
      <span className="flex items-center gap-0.5">
        {workflow.phases.map((phase, index) => (
          <span
            key={`${phase.index}-${phase.title}`}
            title={phase.detail ?? phase.title}
            className={cn(
              "h-1 w-3 rounded-full transition-colors",
              index < progress.current ? "bg-primary/70" : "bg-muted-foreground/20",
            )}
          />
        ))}
      </span>
      {workflow.currentPhase !== undefined ? (
        <span className="truncate text-[11px] text-muted-foreground/85">
          {workflow.currentPhase}
        </span>
      ) : null}
    </div>
  );
}

const AgentsPanelRow = memo(function AgentsPanelRow({
  row,
  onOpenScript,
  onOpenThread,
}: {
  row: AgentRow;
  onOpenScript: (scriptPath: string) => void;
  onOpenThread: (childThreadId: string) => void;
}) {
  const interactive = row.childThreadId !== null;
  return (
    <li className="list-none">
      <div
        className={cn(
          "group/agent-row flex flex-col gap-1 rounded-md px-2.5 py-2 transition-colors",
          interactive && "cursor-pointer hover:bg-muted/50",
        )}
        onClick={interactive ? () => onOpenThread(row.childThreadId as string) : undefined}
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        onKeyDown={
          interactive
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpenThread(row.childThreadId as string);
                }
              }
            : undefined
        }
      >
        <div className="flex min-w-0 items-center gap-2">
          <AgentOrb seed={row.id} state={row.state} size={16} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{row.title}</span>
          {row.state === "active" ? (
            <Loader2 aria-label="Running" className="size-3 shrink-0 animate-spin text-primary" />
          ) : null}
          <UsageSummary row={row} />
        </div>

        {row.progress !== null ? (
          <span className="truncate pl-6 text-[11px] text-muted-foreground/85">{row.progress}</span>
        ) : null}

        <div className="pl-6">
          <WorkflowProgress row={row} />
        </div>

        {/* Run handles. Rendered only when present: a plain subagent has none
            and should not show dead affordances. */}
        {row.scriptPath !== undefined || row.sessionUrl !== undefined ? (
          <div className="flex items-center gap-2 pl-6 pt-0.5">
            {row.scriptPath !== undefined ? (
              <button
                type="button"
                className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenScript(row.scriptPath as string);
                }}
              >
                <FileCode2 aria-hidden className="size-3" />
                script
              </button>
            ) : null}
            {row.sessionUrl !== undefined ? (
              <a
                href={row.sessionUrl}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(event) => event.stopPropagation()}
                className="inline-flex items-center gap-1 rounded-sm text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"
              >
                <ExternalLink aria-hidden className="size-3" />
                session
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
});

function RosterSection({
  title,
  icon,
  rows,
  onOpenScript,
  onOpenThread,
}: {
  title: string;
  icon: React.ReactNode;
  rows: ReadonlyArray<AgentRow>;
  onOpenScript: (scriptPath: string) => void;
  onOpenThread: (childThreadId: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="mb-2">
      <div className="mb-1 mt-3 flex items-center gap-2 px-2.5">
        {icon}
        <span className="text-xs font-medium text-muted-foreground/50">{title}</span>
        <span className="h-px flex-1 bg-sidebar-border/60" />
        <Badge variant="secondary" className="tabular-nums">
          {rows.length}
        </Badge>
      </div>
      <ul>
        {rows.map((row) => (
          <AgentsPanelRow
            key={row.id}
            row={row}
            onOpenScript={onOpenScript}
            onOpenThread={onOpenThread}
          />
        ))}
      </ul>
    </section>
  );
}

export default function AgentsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const [scriptPath, setScriptPath] = useState<string | null>(null);
  const navigate = useNavigate();

  const onOpenThread = useCallback(
    (childThreadId: string) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: threadRef.environmentId, threadId: childThreadId },
      });
    },
    [navigate, threadRef.environmentId],
  );

  const model = buildAgentsPanelModel(projection?.subagents ?? []);

  if (model.agents.length === 0 && model.background.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Bot aria-hidden className="size-5 text-muted-foreground/40" />
        <p className="text-xs text-muted-foreground/70">
          No agents yet. Delegated agents and background work show up here while they run.
        </p>
      </div>
    );
  }

  return (
    <>
      <ScrollArea className="h-full">
        <div className="pb-3">
          <RosterSection
            title="Agents"
            icon={<Bot aria-hidden className="size-3 text-muted-foreground/50" />}
            rows={model.agents}
            onOpenScript={setScriptPath}
            onOpenThread={onOpenThread}
          />
          <RosterSection
            title="Background"
            icon={<TerminalSquare aria-hidden className="size-3 text-muted-foreground/50" />}
            rows={model.background}
            onOpenScript={setScriptPath}
            onOpenThread={onOpenThread}
          />
        </div>
      </ScrollArea>
      <WorkflowScriptDialog
        threadRef={threadRef}
        scriptPath={scriptPath}
        onClose={() => setScriptPath(null)}
      />
    </>
  );
}
