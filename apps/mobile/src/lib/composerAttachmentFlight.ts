import { useSyncExternalStore } from "react";

export interface WindowRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// A captured photo flies from the camera into its composer thumbnail. The thumbnail stays hidden
// while the flight is pending and reports where it landed once it lays out.
type Flight = { readonly onTarget: (rect: WindowRect) => void };

const flights = new Map<string, Flight>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Returns a function that ends the flight and reveals the thumbnail. */
export function beginComposerAttachmentFlight(
  attachmentId: string,
  onTarget: (rect: WindowRect) => void,
): () => void {
  const flight = { onTarget };
  flights.set(attachmentId, flight);
  emit();
  return () => {
    if (flights.get(attachmentId) !== flight) return;
    flights.delete(attachmentId);
    emit();
  };
}

export function reportComposerAttachmentFlightTarget(attachmentId: string, rect: WindowRect) {
  flights.get(attachmentId)?.onTarget(rect);
}

export function useComposerAttachmentInFlight(attachmentId: string): boolean {
  const inFlight = () => flights.has(attachmentId);
  return useSyncExternalStore(subscribe, inFlight, inFlight);
}
