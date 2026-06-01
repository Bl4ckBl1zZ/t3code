import { MessageSquareIcon, PlusIcon } from "lucide-react";
import { memo } from "react";

import type { ThreadContentTab } from "../../threadTabs";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ThreadTabStripProps {
  readonly tabs: ReadonlyArray<ThreadContentTab>;
  readonly canCreateChatTab: boolean;
  readonly creatingChatTab: boolean;
  readonly onSelectTab: (tab: ThreadContentTab) => void;
  readonly onCreateChatTab: () => void;
}

export const ThreadTabStrip = memo(function ThreadTabStrip({
  tabs,
  canCreateChatTab,
  creatingChatTab,
  onSelectTab,
  onCreateChatTab,
}: ThreadTabStripProps) {
  if (tabs.length <= 1 && !canCreateChatTab) {
    return null;
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain"
        role="tablist"
        aria-label="Thread tabs"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.active}
            className={cn(
              "flex h-7 min-w-0 max-w-52 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-ring",
              tab.active
                ? "border-border bg-card text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            onClick={() => onSelectTab(tab)}
          >
            <MessageSquareIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{tab.title}</span>
          </button>
        ))}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="New chat tab"
              disabled={!canCreateChatTab || creatingChatTab}
              onClick={onCreateChatTab}
            />
          }
        >
          <PlusIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {canCreateChatTab ? "New chat tab" : "Start this draft before adding tabs"}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});
