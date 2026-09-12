import { observeVisibleAnimation } from "~/lib/visibleAnimation";

/** A compositor-driven highlight for live status text; the duplicate is decorative. */
export function ActivityFocusText({ text, active = true }: { text: string; active?: boolean }) {
  return (
    <span
      ref={active ? observeVisibleAnimation : undefined}
      className="relative block min-w-0 overflow-hidden truncate"
    >
      {text}
      {active && (
        <span
          aria-hidden
          className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
        >
          <span className="live-activity-focus-counter block">
            <span className="live-activity-focus-aligned block truncate text-foreground">
              {text}
            </span>
          </span>
        </span>
      )}
    </span>
  );
}
