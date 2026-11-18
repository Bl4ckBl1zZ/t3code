import type { ProjectScript } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** @public */
export function projectScriptMenuLabel(
  script: ProjectScript,
  options?: { readonly running?: boolean },
  resolve: MFunctionType = mFallback,
): string {
  const roles = [
    ...(options?.running ? [resolve(msg("running", { $context: "project script role" }))] : []),
    ...(script.runOnWorktreeCreate
      ? [resolve(msg("setup", { $context: "project script role" }))]
      : []),
    ...(script.runOnSettle ? [resolve(msg("on settle", { $context: "project script role" }))] : []),
    ...(script.runOnWorktreeDelete
      ? [resolve(msg("teardown", { $context: "project script role" }))]
      : []),
  ];
  return roles.length === 0
    ? script.name
    : resolve(msg("{name} ({roles})", { name: script.name, roles: roles.join(", ") }));
}
