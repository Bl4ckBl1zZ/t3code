import {
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type T3ProjectFile,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const decodeT3ProjectFile = Schema.decodeExit(T3ProjectFileFromJson);

const NO_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

/**
 * The project's checked-in `t3.json`, decoded. Missing, truncated, or invalid
 * files resolve to `null` — every caller has a defensible default, and a repo
 * mid-edit must not make the surrounding UI flicker or throw.
 */
function useT3ProjectFile(environmentId: EnvironmentId, cwd: string | null): T3ProjectFile | null {
  const query = useProjectFileQuery(environmentId, cwd ?? "", T3_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  return useMemo(() => {
    if (contents === null) return null;
    const decoded = decodeT3ProjectFile(contents);
    return Exit.isFailure(decoded) ? null : decoded.value;
  }, [contents]);
}

/**
 * Scripts declared in the project's checked-in `t3.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useT3ProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<T3ProjectFileScript> {
  return useT3ProjectFile(environmentId, cwd)?.scripts ?? NO_SCRIPTS;
}

/**
 * The project's checked-in `previewUrl`, pinned into the thread's Ports
 * section whether or not anything is serving it.
 */
export function useT3ProjectFilePreviewUrl(
  environmentId: EnvironmentId,
  cwd: string | null,
): string | null {
  const previewUrl = useT3ProjectFile(environmentId, cwd)?.previewUrl;
  return previewUrl !== undefined && previewUrl.length > 0 ? previewUrl : null;
}
