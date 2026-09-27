// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";

// Cursor's Webpack chunks and local helpers must stay beside the SDK entry.
// createRequire also loads that disk-backed package from a Node SEA executable.
// Import every runtime value from here; type-only imports may use "@cursor/sdk".
const requireCursorSdk = NodeModule.createRequire(import.meta.url);
export const {
  Agent,
  AuthenticationError,
  createAgentPlatform,
  Cursor,
  CursorSdkError,
  InMemoryCredentialStore,
} = requireCursorSdk("@cursor/sdk") as typeof import("@cursor/sdk");
