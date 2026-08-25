"use client";

import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import * as React from "react";

import { cn } from "~/lib/utils";

/**
 * A slider over a fixed set of stops.
 *
 * Provider option descriptors that carry `presentation: "slider"` are selects
 * whose options are an ordered scale, so this indexes into the options rather
 * than exposing a continuous range: the value is the stop's position, and the
 * caller maps it back to the option id.
 */
export function StepSlider({
  stops,
  value,
  onValueChange,
  label,
  className,
  disabled,
}: {
  readonly stops: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly value: string;
  readonly onValueChange: (id: string) => void;
  readonly label?: string;
  readonly className?: string;
  readonly disabled?: boolean;
}) {
  const index = Math.max(
    0,
    stops.findIndex((stop) => stop.id === value),
  );
  const max = Math.max(0, stops.length - 1);

  return (
    <div
      className={cn("flex w-full flex-col gap-1.5 px-2 py-1.5", className)}
      // The traits menu drives its own items with the arrow keys. Without this
      // the same press would both move the thumb and move the menu selection.
      onKeyDown={(event) => {
        if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
          event.stopPropagation();
        }
      }}
    >
      <SliderPrimitive.Root
        disabled={disabled ?? false}
        min={0}
        max={max}
        step={1}
        value={index}
        onValueChange={(next) => {
          const stop = stops[Array.isArray(next) ? (next[0] ?? 0) : next];
          if (stop && stop.id !== value) onValueChange(stop.id);
        }}
      >
        {label ? <SliderPrimitive.Label className="sr-only">{label}</SliderPrimitive.Label> : null}
        <SliderPrimitive.Control className="flex h-5 w-full touch-none items-center select-none">
          <SliderPrimitive.Track className="h-1 w-full rounded-full bg-input">
            <SliderPrimitive.Indicator className="rounded-full bg-primary" />
            <SliderPrimitive.Thumb
              className={cn(
                "size-3.5 rounded-full bg-primary shadow-sm outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                "data-[dragging]:scale-110",
              )}
            />
          </SliderPrimitive.Track>
        </SliderPrimitive.Control>
      </SliderPrimitive.Root>
      <div className="flex w-full justify-between text-[10px] text-muted-foreground/70 tabular-nums">
        {stops.map((stop) => (
          <button
            key={stop.id}
            type="button"
            disabled={disabled ?? false}
            // Tapping a tick is the reliable way to hit an exact stop on touch,
            // where dragging a four-stop track is fiddly.
            onClick={() => {
              if (stop.id !== value) onValueChange(stop.id);
            }}
            className={cn(
              "-mx-1 rounded px-1 transition-colors hover:text-foreground",
              stop.id === value ? "font-medium text-foreground" : undefined,
            )}
          >
            {stop.label}
          </button>
        ))}
      </div>
    </div>
  );
}
