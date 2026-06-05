import type { WorkbenchTab } from "@t3tools/client-runtime";
import { FileTextIcon, MessageSquareIcon, PlusIcon, XIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

interface WorkbenchTabStripProps {
  readonly tabs: ReadonlyArray<WorkbenchTab>;
  readonly activeTabId: string | null;
  readonly canCreateChatTab: boolean;
  readonly creatingChatTab: boolean;
  readonly onSelectTab: (tab: WorkbenchTab) => void;
  readonly onCloseTab: (tab: WorkbenchTab) => void;
  readonly onCreateChatTab: () => void;
}

function TabIcon({ tab, active }: { readonly tab: WorkbenchTab; readonly active: boolean }) {
  if (tab.kind === "file") {
    return tab.dirty ? (
      <span
        className={cn("size-2 rounded-full", active ? "bg-primary" : "bg-muted-foreground/70")}
        aria-hidden="true"
      />
    ) : (
      <FileTextIcon className="size-3.5" />
    );
  }
  return <MessageSquareIcon className="size-3.5" />;
}

export const WorkbenchTabStrip = memo(function WorkbenchTabStrip({
  tabs,
  activeTabId,
  canCreateChatTab,
  creatingChatTab,
  onSelectTab,
  onCloseTab,
  onCreateChatTab,
}: WorkbenchTabStripProps) {
  if (tabs.length <= 1 && !canCreateChatTab) {
    return null;
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain"
        role="tablist"
        aria-label="Workbench tabs"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const closable = tab.kind === "chat" || tab.kind === "file";
          return (
            <div
              key={tab.id}
              className={cn(
                "group/tab flex h-7 min-w-0 max-w-56 shrink-0 items-center rounded-md border text-xs transition-colors focus-within:ring-1 focus-within:ring-ring",
                active
                  ? "border-border bg-card text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                }
              }}
              onAuxClick={(event) => {
                if (event.button !== 1 || !closable) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                onCloseTab(tab);
              }}
            >
              <span className="relative ml-1.5 flex size-3.5 shrink-0 items-center justify-center">
                <span
                  className={cn(
                    "flex size-3.5 items-center justify-center transition-opacity",
                    active && closable
                      ? "opacity-0"
                      : closable
                        ? "opacity-100 group-hover/tab:opacity-0 group-focus-within/tab:opacity-0"
                        : "opacity-100",
                  )}
                >
                  <TabIcon tab={tab} active={active} />
                </span>
                {closable ? (
                  <button
                    type="button"
                    className={cn(
                      "pointer-events-none absolute left-1/2 top-1/2 flex size-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm opacity-0 outline-hidden transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
                      active
                        ? "pointer-events-auto opacity-100"
                        : "group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-focus-within/tab:pointer-events-auto group-focus-within/tab:opacity-100",
                    )}
                    aria-label={`Close ${tab.title}`}
                    tabIndex={active ? 0 : -1}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onCloseTab(tab);
                    }}
                  >
                    <XIcon className="size-3" />
                  </button>
                ) : null}
              </span>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1 px-1.5 pr-2 text-left outline-hidden"
                onClick={() => onSelectTab(tab)}
              >
                <span className="min-w-0 truncate">{tab.title}</span>
              </button>
            </div>
          );
        })}
      </div>
      <Menu>
        <MenuTrigger
          type="button"
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="New tab"
          disabled={!canCreateChatTab}
        >
          <PlusIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom" className="min-w-36">
          <MenuItem disabled={!canCreateChatTab || creatingChatTab} onClick={onCreateChatTab}>
            <MessageSquareIcon className="size-4" />
            Chat
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
});
