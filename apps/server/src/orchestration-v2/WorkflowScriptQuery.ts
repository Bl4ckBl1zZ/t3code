/**
 * Read-only access to persisted workflow scripts for the Agents surface's
 * "{} script" affordance. Containment lives in readContainedWorkflowFile,
 * which member transcript reads share.
 *
 * @module WorkflowScriptQuery
 */
import { OrchestrationV2GetWorkflowScriptError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { readContainedWorkflowFile } from "./workflowFileRead.ts";

const SCRIPT_BYTE_CAP = 256 * 1024;

export const readWorkflowScript = Effect.fn("orchestrationV2.readWorkflowScript")(
  function* (input: { readonly scriptPath: string }) {
    const file = yield* readContainedWorkflowFile({
      path: input.scriptPath,
      extension: ".js",
      byteCap: SCRIPT_BYTE_CAP,
    }).pipe(
      Effect.mapError(
        (error) =>
          new OrchestrationV2GetWorkflowScriptError({
            reason: error.reason === "wrong-extension" ? "not-js" : error.reason,
            scriptPath: error.path,
            ...(error.cause === undefined ? {} : { cause: error.cause }),
          }),
      ),
    );
    return { scriptPath: file.path, contents: file.contents, truncated: file.truncated };
  },
);
