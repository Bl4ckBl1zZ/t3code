import { serverEnvironment } from "../state/server";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useContext, useMemo } from "react";

import { agentSessionScan } from "../state/agentSessions";
import { formatEnvironmentQueryError } from "../state/query";

/** Subscribe to each selected computer without coupling their failures or refreshes. */
export function useProjectScans(environmentIds: readonly EnvironmentId[]) {
  const registry = useContext(RegistryContext);
  const scansAtom = useMemo(
    () =>
      Atom.make((get) =>
        environmentIds.map((environmentId) => {
          const config = get(serverEnvironment.configValueAtom(environmentId));
          if (config?.environment.capabilities.agentSessionImport !== true)
            return {
              environmentId,
              data: null,
              error: config === null ? null : "Update this server to import CLI conversations.",
              isPending: config === null,
              refresh: () => undefined,
            };
          const atom = agentSessionScan({ environmentId, input: {} });
          const result = get(atom);
          return {
            environmentId,
            data: Option.getOrNull(AsyncResult.value(result)),
            error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
            isPending: result.waiting || result._tag === "Initial",
            refresh: () => registry.refresh(atom),
          };
        }),
      ),
    [environmentIds, registry],
  );
  return useAtomValue(scansAtom);
}
