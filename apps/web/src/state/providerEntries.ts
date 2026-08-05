import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../providerInstances";
import { primaryServerProvidersAtom } from "./server";

/**
 * Provider instances keyed by their routing id. Threads store only the
 * instance id and model slug, so anything rendering a thread's model —
 * sidebar rows, the relationships panel — resolves display names through
 * this map.
 */
export function useProviderEntryByInstanceId(): ReadonlyMap<string, ProviderInstanceEntry> {
  const providers = useAtomValue(primaryServerProvidersAtom);
  return useMemo(
    () =>
      new Map(
        deriveProviderInstanceEntries(providers).map(
          (entry) => [entry.instanceId as string, entry] as const,
        ),
      ),
    [providers],
  );
}
