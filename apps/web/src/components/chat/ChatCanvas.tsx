import { useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";

import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";

/**
 * Owns the available conversation space. Floating cards (thread details) read
 * the lane geometry from here and use what is left; they never reserve space.
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
    padding: 20,
    maxChatWidth: 768,
  });
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
    return { container, layout: resolveChatCanvasLayout({ ...measurements, container }) };
  }, [measurements]);
  return (
    <ChatCanvasContext value={context}>
      <div
        {...props}
        ref={elementRef}
        data-chat-canvas
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {/* The lane is as wide as the wider of the timeline and the composer,
            each capped by the Chat width setting. */}
        <div
          ref={widthProbeRef}
          aria-hidden
          className="pointer-events-none invisible absolute h-0 w-[max(var(--chat-content-max-width),var(--chat-max-width))] max-w-full box-content ps-3 sm:ps-5"
        />
        {children}
      </div>
    </ChatCanvasContext>
  );
}
