import { LoaderCircleIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import type { WorkingTreeBadgeState } from "./WorkingTreeStatusBadge.logic";

const ANIMATION_DURATION_MS = 500;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Tweens toward the target with an ease-out curve so live diff counts roll instead of jumping. */
function useAnimatedNumber(target: number): number {
  const [displayed, setDisplayed] = useState(target);
  const displayedRef = useRef(target);
  const frameRef = useRef<number | null>(null);
  useEffect(() => {
    if (displayedRef.current === target) return;
    if (prefersReducedMotion()) {
      displayedRef.current = target;
      setDisplayed(target);
      return;
    }
    const from = displayedRef.current;
    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = Math.min((now - startedAt) / ANIMATION_DURATION_MS, 1);
      const eased = 1 - (1 - progress) ** 3;
      const value = Math.round(from + (target - from) * eased);
      displayedRef.current = value;
      setDisplayed(value);
      if (progress < 1) frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [target]);
  return displayed;
}

export const WorkingTreeStatusBadge = memo(function WorkingTreeStatusBadge(props: {
  state: WorkingTreeBadgeState;
  isWorking: boolean;
  className?: string;
}) {
  const { state, isWorking, className } = props;
  const filesChanged = useAnimatedNumber(state.filesChanged);
  const insertions = useAnimatedNumber(state.insertions);
  const deletions = useAnimatedNumber(state.deletions);
  return (
    <div
      role="status"
      aria-label={`${state.filesChanged} files changed, ${state.insertions} additions, ${state.deletions} deletions`}
      className={cn(
        "chat-composer-glass pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1 text-muted-foreground text-xs shadow-sm",
        className,
      )}
    >
      {isWorking ? (
        <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin opacity-70" />
      ) : (
        <span aria-hidden="true" className="size-2 rounded-full border border-border" />
      )}
      {state.currentStep !== null && state.totalSteps !== null && (
        <>
          <span className="tabular-nums">
            Step {state.currentStep} / {state.totalSteps}
          </span>
          <span aria-hidden="true" className="text-muted-foreground/60">
            ·
          </span>
        </>
      )}
      <span className="tabular-nums">
        {filesChanged} {filesChanged === 1 ? "file" : "files"} changed
      </span>
      <span aria-hidden="true" className="inline-flex items-center gap-1 font-mono tabular-nums">
        <span className="text-success">+{insertions}</span>
        <span className="text-destructive">-{deletions}</span>
      </span>
    </div>
  );
});
