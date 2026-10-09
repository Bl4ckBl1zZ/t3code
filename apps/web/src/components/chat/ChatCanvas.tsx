import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";

import { usePanelAnimationSettings } from "../../panelAnimations";
import { ChatCanvasContext } from "./ChatCanvasContext";
import {
  MIN_DOCKED_CHAT_WIDTH,
  resolveChatCanvasLayout,
  type ChatCanvasDetailsCard,
} from "./chatCanvasLayout";

/**
 * Owns the available conversation space. The docked workspace card only
 * reports where it sits; the canvas decides when the conversation lane moves
 * over to make room for it.
 */
export function ChatCanvas({
  children,
  ...props
}: Omit<ComponentProps<"div">, "className" | "style" | "ref">) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const widthProbeRef = useRef<HTMLDivElement | null>(null);
  const [measurements, setMeasurements] = useState({
    width: 0,
    height: 0,
    padding: 48,
    maxChatWidth: 768,
  });
  const [detailsCard, setDetailsCard] = useState<ChatCanvasDetailsCard | null>(null);
  const reportDetailsCard = useCallback((next: ChatCanvasDetailsCard | null) => {
    setDetailsCard((current) => (current?.left === next?.left ? current : next));
  }, []);
  // Docking or undocking the card is a state change the lane may animate
  // (with panel motion on). Resizes move the lane without a transition.
  const docked = detailsCard !== null;
  const [laneShift, setLaneShift] = useState({ docked, shifting: false });
  if (laneShift.docked !== docked) setLaneShift({ docked, shifting: true });
  const { durationMs: panelAnimationDurationMs } = usePanelAnimationSettings();
  useEffect(() => {
    if (!laneShift.shifting) return;
    const timer = window.setTimeout(
      () =>
        setLaneShift((current) => (current.shifting ? { ...current, shifting: false } : current)),
      panelAnimationDurationMs + 50,
    );
    return () => window.clearTimeout(timer);
  }, [laneShift, panelAnimationDurationMs]);
  useLayoutEffect(() => {
    const element = elementRef.current;
    const probe = widthProbeRef.current;
    if (!element || !probe) return;
    const measure = () => {
      const styles = getComputedStyle(probe);
      const next = {
        width: element.clientWidth,
        height: element.clientHeight,
        padding: Number.parseFloat(styles.paddingLeft),
        maxChatWidth: Number.parseFloat(styles.width),
      };
      setMeasurements((current) =>
        current.width === next.width &&
        current.height === next.height &&
        current.padding === next.padding &&
        current.maxChatWidth === next.maxChatWidth
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(probe);
    return () => observer.disconnect();
  }, []);
  const context = useMemo(() => {
    const container = { width: measurements.width, height: measurements.height };
    return {
      container,
      lane: { padding: measurements.padding, minChatWidth: MIN_DOCKED_CHAT_WIDTH },
      layout: resolveChatCanvasLayout({ ...measurements, container, detailsCard }),
      reportDetailsCard,
    };
  }, [measurements, detailsCard, reportDetailsCard]);
  return (
    <ChatCanvasContext value={context}>
      <div
        {...props}
        ref={elementRef}
        data-chat-canvas
        data-lane-shifting={laneShift.shifting || undefined}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        style={{ "--chat-lane-inset-end": `${context.layout.chat.insetEnd}px` } as CSSProperties}
      >
        {/* The lane is as wide as the wider of the timeline and the composer,
            each capped by the Chat width setting. */}
        <div
          ref={widthProbeRef}
          aria-hidden
          className="pointer-events-none invisible absolute h-0 w-[max(var(--chat-content-max-width),var(--chat-max-width))] max-w-full box-content ps-3 sm:ps-12"
        />
        {children}
      </div>
    </ChatCanvasContext>
  );
}
