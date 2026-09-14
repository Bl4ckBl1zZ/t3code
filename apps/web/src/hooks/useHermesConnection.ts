import * as Schema from "effect/Schema";
import { useLocalStorage } from "./useLocalStorage";

/** Keep new conversations on the Hermes connection selected in Work management. */
export function useHermesConnection(environmentId: string | null) {
  return useLocalStorage(`t3code:hermes-connection:${environmentId ?? "none"}`, "", Schema.String);
}
