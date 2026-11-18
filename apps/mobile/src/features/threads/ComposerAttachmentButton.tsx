import type { MenuAction } from "@react-native-menu/menu";
import { useRef, useState } from "react";
import { Pressable, type ViewInstance } from "react-native";

import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import type { WindowRect } from "../../lib/composerAttachmentFlight";
import type { ComposerAddMediaAssets } from "../../state/use-composer-attachment-actions";
import { ComposerAttachmentMenu } from "./ComposerAttachmentMenu";

const ATTACHMENT_MENU_ACTIONS: MenuAction[] = [
  { id: "photos", title: "Photo Library", image: "photo" },
  { id: "files", title: "Choose Files", image: "folder" },
];

export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly size?: "regular" | "large";
  readonly supportsFiles: boolean;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
  /** Enables the in-app camera and photo grid; without it the button opens the system menu. */
  readonly onAddMediaAssets?: ComposerAddMediaAssets;
}) {
  const { scale } = useAndroidControlSizing();
  const buttonRef = useRef<ViewInstance>(null);
  const [menuAnchor, setMenuAnchor] = useState<WindowRect | null>(null);
  const onAddMediaAssets = props.disabled ? undefined : props.onAddMediaAssets;
  const openMenu = () =>
    buttonRef.current?.measureInWindow((x, y, width, height) =>
      setMenuAnchor({ x, y, width, height }),
    );
  const button = (
    <Pressable
      ref={buttonRef}
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
      onPress={
        onAddMediaAssets
          ? openMenu
          : props.supportsFiles
            ? undefined
            : () => void props.onPickMedia()
      }
    >
      <SymbolView
        name="plus"
        size={Math.round((props.size === "large" ? 26 : 20) * scale)}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );

  if (onAddMediaAssets) {
    return (
      <>
        {button}
        {menuAnchor !== null ? (
          <ComposerAttachmentMenu
            anchor={menuAnchor}
            supportsFiles={props.supportsFiles}
            onPickMedia={props.onPickMedia}
            onPickFiles={props.onPickFiles}
            onAddMediaAssets={onAddMediaAssets}
            onDismissed={(after) => {
              setMenuAnchor(null);
              if (after) requestAnimationFrame(after);
            }}
          />
        ) : null}
      </>
    );
  }

  if (props.disabled || !props.supportsFiles) {
    return button;
  }

  return (
    <Menu
      accessible
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      actions={ATTACHMENT_MENU_ACTIONS}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "photos") {
          void props.onPickMedia();
        } else if (nativeEvent.event === "files") {
          void props.onPickFiles();
        }
      }}
    >
      {button}
    </Menu>
  );
}
