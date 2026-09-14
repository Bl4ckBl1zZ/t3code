import * as Schema from "effect/Schema";
import { useLocalStorage } from "./useLocalStorage";

/** Assistant selection belongs to one Hermes connection in one environment. */
export function useHermesProfile(environmentId: string | null, providerInstanceId: string | null) {
  return useLocalStorage(
    `t3code:hermes-profile:${environmentId ?? "none"}:${providerInstanceId ?? "none"}`,
    "default",
    Schema.String,
  );
}
