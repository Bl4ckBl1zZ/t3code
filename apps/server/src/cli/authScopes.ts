import { AuthEnvironmentScope } from "@t3tools/contracts";
import { Flag } from "effect/unstable/cli";

/** Repeatable `--scope` flag; with none given, the command keeps its default grant. */
export const authScopesFlag = (defaults: ReadonlyArray<AuthEnvironmentScope>) =>
  Flag.choice("scope", AuthEnvironmentScope.literals).pipe(
    Flag.withDescription(
      `Authorization scope to grant. Repeat for multiple scopes; replaces the default set: ${defaults.join(", ")}.`,
    ),
    Flag.atLeast(0),
    Flag.map((scopes) => [...new Set(scopes.length > 0 ? scopes : defaults)]),
  );
