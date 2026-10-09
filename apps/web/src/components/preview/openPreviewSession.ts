import type {
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  PreviewViewportSetting,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import { browserDefaultOpenViewport, resolveBrowserDefaults } from "~/browser/browserDefaults";
import {
  applyPreviewServerSnapshot,
  rememberPreviewUrl,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";

interface OpenPreviewSessionInput<E> {
  openPreview: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: PreviewOpenInput;
  }) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;
  threadRef: ScopedThreadRef;
  url?: string;
  /** Overrides the configured default; automation passes an explicit size. */
  viewport?: PreviewViewportSetting;
  profileId?: string;
  /** Merge the new tab without making it the thread's active tab. */
  background?: boolean;
}

export async function openPreviewSession<E>(
  input: OpenPreviewSessionInput<E>,
): Promise<AtomCommandResult<PreviewSessionSnapshot, E>> {
  const defaults = await resolveBrowserDefaults();
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: {
      threadId: input.threadRef.threadId,
      ...(input.url === undefined ? {} : { url: input.url }),
      viewport: input.viewport ?? browserDefaultOpenViewport(defaults),
      profileId: input.profileId ?? defaults.profileId,
    },
  });
  if (result._tag === "Failure") {
    return result;
  }
  const snapshot = result.value;
  if (input.background) updatePreviewServerSnapshot(input.threadRef, snapshot);
  else applyPreviewServerSnapshot(input.threadRef, snapshot);
  if (input.url !== undefined) {
    rememberPreviewUrl(
      input.threadRef,
      snapshot.navStatus._tag === "Idle" ? input.url : snapshot.navStatus.url,
    );
  }
  return result;
}
