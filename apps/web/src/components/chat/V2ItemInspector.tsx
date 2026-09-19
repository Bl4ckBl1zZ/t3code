import {
  orchestrationV2TurnItemStatusIsTerminal,
  type EnvironmentId,
  type OrchestrationV2CommandExecutionItem,
  type OrchestrationV2ProjectedTurnItem,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  backgroundProcessOutcome,
  isBackgroundProcessItem,
  type BackgroundProcessOutcome,
} from "@t3tools/shared/backgroundProcess";
import * as DateTime from "effect/DateTime";
import { ChevronRightIcon, ExternalLinkIcon, GitBranchIcon, RotateCcwIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { useV2ItemSupport } from "../../state/v2ItemSupport";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import ChatMarkdown from "../ChatMarkdown";
import { resolveExternalWebLinkHref } from "./externalLinkContextMenu";

interface V2ItemInspectorProps {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly cwd?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
  readonly onRollbackCheckpoint?: (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => void;
}

function durationLabel(
  startedAt: DateTime.Utc | null,
  completedAt: DateTime.Utc | null,
): string | null {
  if (startedAt === null) return null;
  const end = completedAt === null ? Date.now() : DateTime.toEpochMillis(completedAt);
  const milliseconds = Math.max(0, end - DateTime.toEpochMillis(startedAt));
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

interface CommandExitLine {
  readonly tone: BackgroundProcessOutcome["tone"];
  readonly text: string;
}

/**
 * The status line under a finished command's output, or null while it runs.
 * A background command that did not finish cleanly shows its outcome instead of
 * the exit code, because "killed with the session" and "failed" can share a code
 * and mean opposite things.
 */
export function commandExitLine(item: OrchestrationV2CommandExecutionItem): CommandExitLine | null {
  if (!orchestrationV2TurnItemStatusIsTerminal(item.status)) return null;
  const duration =
    item.completedAt === null ? null : durationLabel(item.startedAt, item.completedAt);
  const suffix = duration ? ` · ${duration}` : "";
  const outcome = isBackgroundProcessItem(item) ? backgroundProcessOutcome(item) : null;
  if (outcome !== null && outcome.tone !== "success") {
    return { tone: outcome.tone, text: `${outcome.label}${suffix}` };
  }
  if (item.exitCode === undefined) return null;
  return {
    tone: item.exitCode === 0 ? "success" : "danger",
    text: `Exited with code ${item.exitCode}${suffix}`,
  };
}

const EXIT_LINE_TONE_CLASS_NAME: Record<CommandExitLine["tone"], string> = {
  success: "text-emerald-600",
  danger: "text-destructive",
  warning: "text-warning",
  neutral: "text-muted-foreground",
};

const TERMINAL_BLOCK_CLASS_NAME =
  "max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground select-text";

function DataField(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground/70">{props.label}</dt>
      <dd className="mt-0.5 min-w-0 break-words font-mono text-[11px] text-foreground/80">
        {props.children}
      </dd>
    </div>
  );
}

function StructuredValue({ value }: { readonly value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return null;
  return <pre className={TERMINAL_BLOCK_CLASS_NAME}>{text}</pre>;
}

/** The command and what it printed, read top to bottom like a terminal. */
function CommandTranscript({ item }: { readonly item: OrchestrationV2CommandExecutionItem }) {
  const output = item.output?.trimEnd() ?? "";
  const exitLine = commandExitLine(item);
  return (
    <div className="space-y-1">
      <pre className={TERMINAL_BLOCK_CLASS_NAME}>
        <span className="select-none text-muted-foreground/60">$ </span>
        <span className="text-foreground/85">{item.input}</span>
        {output ? (
          `\n${output}`
        ) : orchestrationV2TurnItemStatusIsTerminal(item.status) ? (
          <span className="text-muted-foreground/60">{"\n"}No output</span>
        ) : null}
      </pre>
      {exitLine ? (
        <p className={cn("text-[11px]", EXIT_LINE_TONE_CLASS_NAME[exitLine.tone])}>
          {exitLine.text}
        </p>
      ) : null}
    </div>
  );
}

export const V2ItemInspector = memo(function V2ItemInspector(props: V2ItemInspectorProps) {
  const { item } = props.projectedItem;
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: props.projectedItem.sourceThreadId,
    sourceItemId: props.projectedItem.sourceItemId,
  });
  const duration = durationLabel(item.startedAt, item.completedAt);
  const latestAttempt = support.attempts.at(-1) ?? null;
  const runtimeRequest = support.runtimeRequest;

  return (
    <div className="space-y-2 text-xs" data-v2-item-inspector={item.type}>
      {item.type === "reasoning" && item.text ? (
        <div className="rounded-md border border-border/45 bg-muted/15 p-2 italic text-muted-foreground">
          <ChatMarkdown text={item.text} cwd={props.cwd} lineBreaks />
        </div>
      ) : null}

      {item.type === "command_execution" ? <CommandTranscript item={item} /> : null}

      {item.type === "file_change" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-muted-foreground">
            {formatWorkspaceRelativePath(item.fileName, props.workspaceRoot)}
          </span>
          {item.additions !== undefined || item.deletions !== undefined ? (
            <span>
              <span className="text-emerald-600">+{item.additions ?? 0}</span>{" "}
              <span className="text-destructive">-{item.deletions ?? 0}</span>
            </span>
          ) : null}
          {item.runId !== null ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => props.onOpenTurnDiff(item.runId!, item.fileName)}
            >
              Open diff
            </Button>
          ) : null}
          {item.diffStr ? <StructuredValue value={item.diffStr} /> : null}
        </div>
      ) : null}

      {item.type === "file_search" && item.results ? (
        <ul className="space-y-1 rounded-md border border-border/45 p-2">
          {item.results.map((result) => (
            <li key={JSON.stringify(result)}>
              <span className="font-mono text-foreground/80">
                {formatWorkspaceRelativePath(result.fileName, props.workspaceRoot)}
                {result.line === undefined ? "" : `:${result.line}`}
                {result.column === undefined ? "" : `:${result.column}`}
              </span>
              {result.preview ? (
                <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{result.preview}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {item.type === "web_search" && item.results ? (
        <ul className="space-y-1.5 rounded-md border border-border/45 p-2">
          {item.results.map((result) => {
            const safeHref = resolveExternalWebLinkHref(result.url);
            return (
              <li key={JSON.stringify(result)}>
                {safeHref ? (
                  <a
                    href={safeHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
                  >
                    {result.title ?? result.url}
                    <ExternalLinkIcon className="size-3" />
                  </a>
                ) : (
                  <p className="font-medium text-foreground">
                    {result.title ?? result.url ?? "Search result"}
                  </p>
                )}
                {result.snippet ? <p className="text-muted-foreground">{result.snippet}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {item.type === "dynamic_tool" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-[10px] font-medium tracking-wide uppercase text-muted-foreground">
              Input
            </p>
            <StructuredValue value={item.input} />
          </div>
          {item.output !== undefined ? (
            <div>
              <p className="mb-1 text-[10px] font-medium tracking-wide uppercase text-muted-foreground">
                Output
              </p>
              <StructuredValue value={item.output} />
            </div>
          ) : null}
        </div>
      ) : null}

      {item.type === "checkpoint" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">
            {support.checkpoint?.status ?? item.status} · {item.files.length} files
          </span>
          {props.onRollbackCheckpoint && support.checkpoint?.status === "ready" ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                props.onRollbackCheckpoint?.({
                  checkpointId: item.checkpointId,
                  scopeId: item.scopeId,
                })
              }
            >
              <RotateCcwIcon className="size-3" />
              Restore…
            </Button>
          ) : null}
        </div>
      ) : null}

      {item.type === "fork" ? (
        <Button size="xs" variant="outline" onClick={() => props.onOpenThread(item.targetThreadId)}>
          <GitBranchIcon className="size-3" />
          Open fork
        </Button>
      ) : null}

      {item.type === "handoff" ? (
        <div className="space-y-1 rounded-md border border-border/45 p-2 text-muted-foreground">
          <p>
            {item.fromProviderInstanceIds.join(", ")} → {item.toProviderInstanceId}
          </p>
          <p>
            {item.strategy.replaceAll("_", " ")} · {support.contextHandoff?.status ?? item.status}
          </p>
          {support.contextTransfer ? (
            <p>
              Transfer {support.contextTransfer.type.replaceAll("_", " ")} ·{" "}
              {support.contextTransfer.status}
            </p>
          ) : null}
        </div>
      ) : null}

      <details className="group/details">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon className="size-3 group-open/details:rotate-90" />
          Details
        </summary>
        <div className="mt-1.5 space-y-2">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-border/45 bg-muted/15 p-2 sm:grid-cols-3">
            <DataField label="Item">{item.type}</DataField>
            <DataField label="Status">{item.status}</DataField>
            {duration ? <DataField label="Duration">{duration}</DataField> : null}
            {support.run ? <DataField label="Run">{support.run.status}</DataField> : null}
            {latestAttempt ? (
              <DataField label="Attempt">
                {latestAttempt.attemptOrdinal} · {latestAttempt.status} · {latestAttempt.reason}
              </DataField>
            ) : null}
            {support.node ? (
              <DataField label="Node">
                {support.node.kind} · {support.node.status}
              </DataField>
            ) : null}
            {support.providerThread ? (
              <DataField label="Provider thread">
                {support.providerThread.providerInstanceId} · {support.providerThread.status}
              </DataField>
            ) : null}
            {support.providerTurn ? (
              <DataField label="Provider turn">{support.providerTurn.status}</DataField>
            ) : null}
            {support.providerSession ? (
              <DataField label="Session">
                {support.providerSession.status} ·{" "}
                {support.providerSession.model ?? "default model"}
              </DataField>
            ) : null}
            {support.providerSession ? (
              <DataField label="Working directory">{support.providerSession.cwd}</DataField>
            ) : null}
            {runtimeRequest ? (
              <DataField label="Request">
                {runtimeRequest.status} · {runtimeRequest.responseCapability.type}
              </DataField>
            ) : null}
          </dl>

          {support.attempts.length > 1 ? (
            <div className="rounded-md border border-border/45 bg-background/40 p-2">
              <p className="mb-1 text-[11px] text-muted-foreground/70">
                Attempt history · {support.attempts.length}
              </p>
              <ol className="space-y-1 font-mono text-[11px] text-muted-foreground">
                {support.attempts.map((attempt) => (
                  <li key={attempt.id} className="flex items-center justify-between gap-3">
                    <span>
                      Attempt {attempt.attemptOrdinal} · {attempt.reason.replaceAll("_", " ")}
                    </span>
                    <span>{attempt.status}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          <details
            className="rounded-md border border-border/45 bg-background/40"
            data-v2-structured-details="true"
          >
            <summary className="flex cursor-pointer list-none items-center px-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              Structured details
            </summary>
            <div className="border-t border-border/45 p-2">
              <StructuredValue value={item} />
            </div>
          </details>
        </div>
      </details>
    </div>
  );
});
