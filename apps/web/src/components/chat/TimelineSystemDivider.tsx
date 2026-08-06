import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";

export function TimelineSystemDivider(props: {
  readonly label: string;
  readonly detail?: ReactNode | null;
  readonly tone?: "neutral" | "danger";
  readonly icon?: LucideIcon;
  /** Stacked puts the detail on its own centered line under the label. */
  readonly layout?: "inline" | "stacked";
  /** In-flight system work: spins the icon and pulses the label. */
  readonly busy?: boolean;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  /** Expandable boundaries (e.g. a collapsed attempt) announce their state. */
  readonly expanded?: boolean;
  /** Escape hatch for test/scroll hooks that need to find a specific row. */
  readonly dataAttributes?: Readonly<Record<`data-${string}`, string>>;
}) {
  const Icon = props.icon;
  const stacked = props.layout === "stacked";
  const label = (
    <span className={cn("font-medium", props.busy && "animate-pulse motion-reduce:animate-none")}>
      {props.label}
    </span>
  );
  const detail = props.detail ? (
    <span className="max-w-80 truncate opacity-70">
      {stacked ? props.detail : <>· {props.detail}</>}
    </span>
  ) : null;
  const icon = Icon ? (
    <Icon
      className={cn("size-3 shrink-0", props.busy && "animate-spin motion-reduce:animate-none")}
    />
  ) : null;
  const content = stacked ? (
    <span className="flex min-w-0 flex-col items-center gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        {icon}
        {label}
      </span>
      {detail}
    </span>
  ) : (
    <>
      {icon}
      {label}
      {detail}
    </>
  );

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 py-2 text-[11px] text-muted-foreground",
        props.tone === "danger" && "text-destructive",
      )}
    >
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
      {props.onAction ? (
        <button
          type="button"
          aria-label={props.actionLabel}
          {...(props.expanded === undefined ? {} : { "aria-expanded": props.expanded })}
          onClick={props.onAction}
          className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          title={props.actionLabel}
          {...props.dataAttributes}
        >
          {content}
        </button>
      ) : (
        <span
          className="flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1"
          {...props.dataAttributes}
        >
          {content}
        </span>
      )}
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
    </div>
  );
}
