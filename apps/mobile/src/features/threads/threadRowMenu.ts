import type { MenuAction } from "@react-native-menu/menu";

/** Long-press menu event id for the AI title regeneration action. */
export const REGENERATE_TITLE_MENU_ACTION_ID = "regenerate-title";

/**
 * Adds "Regenerate title" to a thread row's long-press menu, mirroring the web
 * sidebar. The action is omitted entirely on servers without the
 * `threadTitleRegeneration` capability (version skew: the command would be
 * rejected), and disabled while the server-side marker says a regeneration is
 * already in flight.
 *
 * It sits directly above Delete so the destructive item stays last.
 */
export function withTitleRegenerationMenuAction(
  actions: ReadonlyArray<MenuAction>,
  input: { readonly supported: boolean; readonly regenerating: boolean },
): MenuAction[] {
  if (!input.supported) return [...actions];
  const action: MenuAction = {
    id: REGENERATE_TITLE_MENU_ACTION_ID,
    title: input.regenerating ? "Regenerating…" : "Regenerate title",
    image: "sparkles",
    attributes: { disabled: input.regenerating },
  };
  const deleteIndex = actions.findIndex((candidate) => candidate.id === "delete");
  if (deleteIndex < 0) return [...actions, action];
  return [...actions.slice(0, deleteIndex), action, ...actions.slice(deleteIndex)];
}
