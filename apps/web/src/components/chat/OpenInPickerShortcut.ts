import {
  buildRemoteOpenUrl,
  type EditorId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useEffect } from "react";

import { usePreferredEditor } from "../../editorPreferences";
import { isOpenFavoriteEditorShortcut } from "../../keybindings";
import {
  openRemoteEditorUrl,
  useRemoteCapableEditors,
  useRemoteOpenHint,
  useRemoteOpenState,
} from "../../remoteOpen";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

export function useOpenFavoriteEditorShortcut({
  enabled,
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
}: {
  enabled: boolean;
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}) {
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const remote = useRemoteOpenState(environmentId);
  const remoteCapableEditors = useRemoteCapableEditors();
  const [, markRemoteHintSeen] = useRemoteOpenHint();
  // Mirrors OpenInPicker: on a remote environment the server's PATH probe says
  // nothing about what the viewing machine can launch, so the favorite has to
  // come from the same list the picker offers.
  const effectiveEditors = remote.mode === "local-exec" ? availableEditors : remoteCapableEditors;
  const [preferredEditor] = usePreferredEditor(effectiveEditors);

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(event, keybindings)) return;
      if (!openInCwd || !preferredEditor) return;
      if (remote.mode === "remote-unavailable") return;

      event.preventDefault();
      if (remote.mode === "remote-links") {
        const url = buildRemoteOpenUrl({
          editor: preferredEditor,
          host: remote.host.host,
          absolutePath: openInCwd,
        });
        if (url === undefined) return;
        void openRemoteEditorUrl(url).then((opened) => {
          if (opened) markRemoteHintSeen();
        });
        return;
      }
      void openInEditorMutation({
        environmentId,
        input: {
          cwd: openInCwd,
          editor: preferredEditor,
        },
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    enabled,
    environmentId,
    keybindings,
    markRemoteHintSeen,
    openInCwd,
    openInEditorMutation,
    preferredEditor,
    remote,
  ]);
}
