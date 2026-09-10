export interface WorkGroupScrollAnchor {
  readonly entryId: string;
  readonly offset: number;
}

/** Per-conversation UI state survives virtual row unmounts, with bounded retention. */
export class WorkGroupHistoryState {
  private readonly values = new Map<
    string,
    { expanded?: boolean; anchor?: WorkGroupScrollAnchor }
  >();
  constructor(private readonly limit = 1000) {}

  get(id: string) {
    return this.values.get(id);
  }
  set(id: string, patch: { expanded?: boolean; anchor?: WorkGroupScrollAnchor }) {
    const value = { ...this.values.get(id), ...patch };
    this.values.delete(id);
    this.values.set(id, value);
    while (this.values.size > this.limit) this.values.delete(this.values.keys().next().value!);
  }
}

/** Use measured row positions rather than a virtualizer's possibly stale visible range. */
export function captureWorkGroupAnchor(state: {
  readonly data: readonly { readonly id: string }[];
  readonly scroll: number;
  readonly positionAtIndex: (index: number) => number | undefined;
}): WorkGroupScrollAnchor | undefined {
  if (state.data.length === 0 || !Number.isFinite(state.scroll)) return undefined;
  const scroll = Math.max(0, state.scroll);
  let low = 0,
    high = state.data.length - 1,
    index = 0;
  let top = state.positionAtIndex(0);
  if (top === undefined || !Number.isFinite(top)) return undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const position = state.positionAtIndex(middle);
    if (position === undefined || !Number.isFinite(position)) return undefined;
    if (position <= scroll) {
      index = middle;
      top = position;
      low = middle + 1;
    } else high = middle - 1;
  }
  return { entryId: state.data[index]!.id, offset: Math.max(0, scroll - top) };
}

export function restoreWorkGroupAnchor(
  entries: readonly { readonly id: string }[],
  anchor: WorkGroupScrollAnchor | undefined,
) {
  if (!anchor || !Number.isFinite(anchor.offset)) return undefined;
  const index = entries.findIndex((entry) => entry.id === anchor.entryId);
  return index < 0 ? undefined : { index, viewOffset: -Math.max(0, anchor.offset) };
}

export function shouldFollowWorkGroupAppend(
  previous: readonly { readonly id: string }[],
  next: readonly { readonly id: string }[],
  atEnd: boolean,
) {
  return (
    atEnd &&
    previous.length > 0 &&
    next.length > previous.length &&
    previous.every((entry, i) => entry.id === next[i]?.id)
  );
}
