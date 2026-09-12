import { useLayoutEffect, useRef, type ComponentProps } from "react";
import type { SnapShotSource } from "@t3tools/contracts";
import {
  scheduleSnapShotAnimationDestination,
  setSnapShotAnimationDestination,
} from "../../lib/snapShotAnimation";

export function SnapShotAttachmentFrame({
  animationId,
  source,
  ...props
}: ComponentProps<"div"> & {
  animationId?: string | undefined;
  source?: SnapShotSource | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const frame = ref.current;
    if (!frame || !animationId) return;
    frame.scrollIntoView({ block: "nearest", inline: "nearest" });
    return scheduleSnapShotAnimationDestination(animationId, () =>
      setSnapShotAnimationDestination(animationId, frame, source),
    );
  }, [animationId, source]);
  return <div {...props} ref={ref} />;
}
