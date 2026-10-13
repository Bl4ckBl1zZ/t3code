import { requireOptionalNativeModule } from "expo";
import * as Effect from "effect/Effect";

import type { SwiftSavedEnvironments } from "./swift-import";

interface T3SwiftImportModule {
  readonly readSavedEnvironments: () => Promise<SwiftSavedEnvironments>;
}

/**
 * Reads what the SwiftUI client saved under this bundle id. Null where the
 * native module does not exist (Android). Fails when the Keychain is not
 * readable yet, so the import is retried on a later launch.
 */
export const readSwiftSavedEnvironments = Effect.suspend(() => {
  const module = requireOptionalNativeModule<T3SwiftImportModule>("T3SwiftImport");
  return module === null
    ? Effect.succeed(null)
    : Effect.tryPromise(() => module.readSavedEnvironments());
});
