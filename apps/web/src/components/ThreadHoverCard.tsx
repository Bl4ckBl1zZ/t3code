import type { ComponentProps, ReactNode } from "react";

import { TooltipPopup } from "./ui/tooltip";

export function ThreadHoverCardPopup(props: Omit<ComponentProps<typeof TooltipPopup>, "variant">) {
  return <TooltipPopup {...props} variant="glass" />;
}

/**
 * Shared title, metadata spacing, and optional footer for thread previews: the
 * sidebar's thread hover and a subagent's lineage and timeline hovers.
 */
export function ThreadHoverCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    // The viewport's own inset (py-1 px-2) plus this one make the floating inset.
    <div className="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2 text-left">
      <div className="min-w-0 truncate text-xs leading-tight font-medium text-foreground">
        {title}
      </div>
      <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">{children}</div>
      {footer}
    </div>
  );
}
