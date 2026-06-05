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
    <div className="flex min-w-0 items-center gap-1.5">
      <div
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overscroll-x-contain"
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
                "group/tab flex h-8 min-w-0 max-w-56 shrink-0 items-center rounded-[7px] border text-xs shadow-xs/5 transition-[background-color,border-color,box-shadow,color] focus-within:ring-1 focus-within:ring-ring",
                active
                  ? "border-border bg-card text-foreground shadow-sm"
                  : "border-border/60 bg-muted/35 text-muted-foreground hover:bg-muted/65 hover:text-foreground",
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
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 text-left outline-hidden"
                onClick={() => onSelectTab(tab)}
              >
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  <TabIcon tab={tab} active={active} />
                </span>
                <span className="min-w-0 truncate">{tab.title}</span>
              </button>
              {closable ? (
                <button
                  type="button"
                  className="mr-1.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-muted-foreground outline-hidden transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                  aria-label={`Close ${tab.title}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onCloseTab(tab);
                  }}
                >
                  <XIcon className="size-3" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <Menu>
        <MenuTrigger
          type="button"
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[7px] text-muted-foreground outline-hidden transition-colors hover:bg-muted/65 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
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
