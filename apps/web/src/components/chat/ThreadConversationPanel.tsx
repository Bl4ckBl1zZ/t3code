import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { hermesRuntimeModeChoice } from "@t3tools/shared/runtimeModes";
import { useMemo } from "react";

import { useThreadShell } from "../../state/entities";
import { useProviderEntryByInstanceId } from "../../state/providerEntries";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { resolveThreadModelBadge } from "./threadModelBadge";

/**
 * Thread details panel section describing the conversation itself.
 *
 * Only rendered for T3 Work, where there is no workspace, no ports and no
 * version control to describe — without it the panel has nothing to say until
 * the conversation happens to schedule or delegate something. Everything here
 * comes off the thread shell the sidebar already subscribes to, so the section
 * costs no extra traffic.
 */
export function ThreadConversationPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const shell = useThreadShell(threadRef);
  const providerEntryByInstanceId = useProviderEntryByInstanceId();

  if (shell === null) return null;

  const modelBadge = resolveThreadModelBadge({
    modelSelection: shell.modelSelection,
    providerEntry: providerEntryByInstanceId.get(shell.modelSelection?.instanceId ?? "") ?? null,
  });
  // Hermes collapses the four runtime modes to two, so a thread carrying `auto`
  // in from elsewhere still has to read as one of the labels its picker offers.
  const accessLabel = hermesRuntimeModeChoice(shell.runtimeMode).label;
  const lastActiveAt = shell.latestUserMessageAt ?? shell.updatedAt;

  const rows: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
    ...(modelBadge === null
      ? []
      : [
          {
            label: "Model",
            value:
              modelBadge.reasoning === null
                ? modelBadge.model
                : `${modelBadge.model} · ${modelBadge.reasoning}`,
          },
        ]),
    { label: "Access", value: accessLabel },
    { label: "Started", value: formatRelativeTimeLabel(shell.createdAt) },
    ...(lastActiveAt === null
      ? []
      : [{ label: "Last active", value: formatRelativeTimeLabel(lastActiveAt) }]),
  ];

  return (
    <section
      aria-labelledby="thread-details-conversation-heading"
      className="border-t border-border/65 px-2 pb-2.5 pt-2"
      data-thread-conversation-panel
    >
      <div className="mb-1 flex min-h-8 items-center px-2">
        <h3
          id="thread-details-conversation-heading"
          className="text-[11px] font-medium text-muted-foreground"
        >
          Conversation
        </h3>
      </div>
      <dl className="m-0 flex flex-col gap-0.5 px-2.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-[11px] text-muted-foreground">{row.label}</dt>
            <dd className="m-0 min-w-0 truncate text-[11px] text-foreground/80">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
