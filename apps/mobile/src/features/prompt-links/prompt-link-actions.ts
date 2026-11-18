import * as Dialog from "../../components/ui/Dialog";
import { resolveHostedAppUrl } from "@t3tools/shared/connectAuth";
import { buildNewThreadLink, type LinkedPrompt } from "@t3tools/shared/promptLinks";
import Constants from "expo-constants";
import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";

import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import {
  getComposerDraftSnapshot,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { linkedThreadDraftAction } from "./prompt-link-model";

export function showPromptLinkNotice(notice: string): void {
  Dialog.alert(m(msg("Prompt from a link")), notice);
}

export async function applyLinkedPromptToThreadDraft(
  draftKey: string,
  prompt: LinkedPrompt,
  notice: string,
): Promise<void> {
  try {
    await waitForComposerDraftsLoaded();
  } catch {
    Dialog.alert(
      m(msg("Could not open link")),
      m(msg("Drafts could not be loaded, so the prompt was not added.")),
    );
    return;
  }
  const action = linkedThreadDraftAction(getComposerDraftSnapshot(draftKey).text, prompt.text);
  if (action !== "ask") {
    if (action === "fill") setComposerDraftText(draftKey, prompt.text);
    showPromptLinkNotice(notice);
    return;
  }
  Dialog.alert(m(msg("Linked prompt ready. Replace draft?")), notice, [
    { text: m(msg("Keep mine")), style: "cancel" },
    {
      text: m(msg("Replace", { $context: "verb, replaces the draft" })),
      onPress: () => setComposerDraftText(draftKey, prompt.text),
    },
  ]);
}

/**
 * The hosted app prompt links open on, or null when this build has none; sharing is then
 * hidden rather than handing out links to upstream's app.
 */
export const promptLinkOrigin = resolveHostedAppUrl(
  typeof Constants.expoConfig?.extra?.hostedAppUrl === "string"
    ? Constants.expoConfig.extra.hostedAppUrl
    : undefined,
);

export async function copyPromptLink(prompt: string, origin: string): Promise<void> {
  if (
    !(await tryCopyTextWithHaptic(buildNewThreadLink({ prompt, origin }), {
      target: "prompt link",
    }))
  ) {
    Dialog.alert(m(msg("Could not copy")), m(msg("Try again.")));
  }
}
