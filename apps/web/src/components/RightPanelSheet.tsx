import { type ReactNode } from "react";

import { RIGHT_PANEL_SHEET_CLASS_NAME } from "../rightPanelLayout";
import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  children: ReactNode;
  animationDurationMs?: number;
  open: boolean;
  underFloatingPreview?: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        {...(props.animationDurationMs === undefined
          ? {}
          : { transitionDurationMs: props.animationDurationMs })}
        side="right"
        showCloseButton={false}
        keepMounted
        {...(props.underFloatingPreview
          ? { backdropClassName: "z-[35]", viewportClassName: "z-[35]" }
          : {})}
        className={RIGHT_PANEL_SHEET_CLASS_NAME}
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
