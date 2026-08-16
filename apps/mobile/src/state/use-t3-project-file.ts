import {
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectReadFileResult,
  type T3ProjectFile,
} from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { useMemo } from "react";

import { projectEnvironment } from "./projects";
import { useEnvironmentQuery } from "./query";

const decodeT3ProjectFile = Schema.decodeExit(T3ProjectFileFromJson);

/**
 * The project's checked-in `t3.json`, decoded. Missing, truncated, or invalid
 * files resolve to `null`: every caller has a defensible default, and a repo
 * mid-edit must not make the surrounding UI flicker or throw.
 */
function useT3ProjectFile(environmentId: EnvironmentId | null, cwd: string | null) {
  const query = useEnvironmentQuery(
    environmentId === null || cwd === null
      ? null
      : projectEnvironment.readFile({
          environmentId,
          input: { cwd, relativePath: T3_PROJECT_FILE_NAME },
        }),
  );
  const result = query.data as ProjectReadFileResult | null;
  const contents = result && !result.truncated ? result.contents : null;
  return useMemo<T3ProjectFile | null>(() => {
    if (contents === null) return null;
    const decoded = decodeT3ProjectFile(contents);
    return Exit.isFailure(decoded) ? null : decoded.value;
  }, [contents]);
}

/**
 * The project's checked-in `previewUrl`, pinned into the thread's Ports menu
 * whether or not anything is serving it — the same row the desktop panel pins,
 * and on a phone often the only one that is reachable at all, since it names a
 * real host rather than the loopback address of a machine that is not this one.
 */
export function useT3ProjectFilePreviewUrl(
  environmentId: EnvironmentId | null,
  cwd: string | null,
): string | null {
  const previewUrl = useT3ProjectFile(environmentId, cwd)?.previewUrl;
  return previewUrl !== undefined && previewUrl.length > 0 ? previewUrl : null;
}
