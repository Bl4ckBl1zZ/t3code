import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { BackHandler, Platform, Pressable, useColorScheme, View } from "react-native";
import Animated, { FadeOut, ZoomIn } from "react-native-reanimated";

import { appBlurTargetRef } from "../lib/appBlurTarget";
import { cn } from "../lib/cn";
import { useThemeColor } from "../lib/useThemeColor";
import { type AppSymbolName, SymbolView } from "./AppSymbol";
import { AppText as Text } from "./AppText";
import { OverlayPortal } from "./OverlayPortal";

const MENU_WIDTH = 252;
const SCREEN_MARGIN = 12;
const ANCHOR_GAP = 10;

export type ComposerAttachmentMenuItem = {
  readonly id: string;
  readonly title: string;
  readonly icon: AppSymbolName;
};

type AnchorSnapshot = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

type OverlayFrame = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/**
 * Attachment source menu for the composer "+" buttons: a frosted card that
 * springs up from the anchor with one large row per source (leading circled
 * glyph + label), replacing the platform menus whose icon treatment can't
 * match this layout. Renders through OverlayPortal so the keyboard stays up
 * while it is open; the anchor is snapshotted in window coordinates at open
 * time, mirroring AndroidAnchoredMenu.
 */
export function ComposerAttachmentMenu(props: {
  readonly items: ReadonlyArray<ComposerAttachmentMenuItem>;
  readonly onSelect: (id: string) => void;
  readonly children: ReactNode;
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const [anchor, setAnchor] = useState<AnchorSnapshot | null>(null);
  const [overlay, setOverlay] = useState<OverlayFrame | null>(null);
  const [rootHeight, setRootHeight] = useState<number | null>(null);
  const anchorRef = useRef<View>(null);
  const overlayRef = useRef<View>(null);

  const isDarkMode = useColorScheme() === "dark";
  const rippleColor = useThemeColor("--color-subtle");
  const iconColor = useThemeColor("--color-icon");

  const close = useCallback(() => {
    setAnchor(null);
    setOverlay(null);
    setRootHeight(null);
  }, []);

  const open = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    anchorRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height });
    });
  }, []);

  const measureOverlay = useCallback(() => {
    overlayRef.current?.measureInWindow((x, y, width, height) => {
      setOverlay({ x, y, width, height });
      setRootHeight(height);
    });
  }, []);

  // In-window overlay (no Modal takes focus), so the Android hardware back
  // gesture needs explicit handling while the menu is open.
  useEffect(() => {
    if (anchor === null) {
      return;
    }
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => subscription.remove();
  }, [anchor, close]);

  const local =
    anchor === null || overlay === null
      ? null
      : {
          x: anchor.x - overlay.x,
          y: anchor.y - overlay.y,
          width: anchor.width,
          height: anchor.height,
        };
  const left =
    local === null || overlay === null
      ? 0
      : Math.min(Math.max(local.x, SCREEN_MARGIN), overlay.width - MENU_WIDTH - SCREEN_MARGIN);
  // The composer anchors sit at the bottom of the screen, so the card always
  // opens upward: pinned by its bottom edge above the anchor, growing up.
  const maxHeight = local === null ? 0 : Math.max(0, local.y - ANCHOR_GAP - SCREEN_MARGIN);
  const placeable = local !== null && rootHeight !== null;

  const onPressItem = useCallback(
    (id: string) => {
      close();
      props.onSelect(id);
    },
    [close, props.onSelect],
  );

  return (
    <>
      <Pressable
        ref={anchorRef}
        accessibilityRole="button"
        className={props.className}
        collapsable={false}
        style={props.style}
        onPress={open}
      >
        <View pointerEvents="none">{props.children}</View>
      </Pressable>
      {anchor === null ? null : (
        <OverlayPortal>
          <View
            ref={overlayRef}
            collapsable={false}
            className="absolute inset-0"
            onLayout={measureOverlay}
          >
            <Pressable accessible={false} className="absolute inset-0" onPress={close} />
            {!placeable || local === null ? null : (
              <Animated.View
                entering={ZoomIn.springify().damping(19).stiffness(320)}
                exiting={FadeOut.duration(100)}
                className="absolute overflow-hidden rounded-[26px] border border-border shadow-2xl"
                style={{
                  left,
                  width: MENU_WIDTH,
                  maxHeight,
                  bottom: (rootHeight ?? 0) - local.y + ANCHOR_GAP,
                  // Spring from the anchor corner, like a context menu.
                  transformOrigin: "left bottom",
                }}
              >
                {/* Frosted backdrop: blur of the app content behind the menu,
                    washed with the translucent card tone so rows keep contrast. */}
                <BlurView
                  intensity={40}
                  tint={isDarkMode ? "dark" : "light"}
                  className="absolute inset-0"
                  {...(Platform.OS === "android"
                    ? { blurMethod: "dimezisBlurView" as const, blurTarget: appBlurTargetRef }
                    : {})}
                />
                <View className="absolute inset-0 bg-card-translucent" />
                <View className="py-2">
                  {props.items.map((item) => (
                    <Pressable
                      key={item.id}
                      accessibilityRole="button"
                      accessibilityLabel={item.title}
                      android_ripple={{ color: rippleColor }}
                      className={cn("flex-row items-center gap-3.5 px-3 py-2 active:opacity-60")}
                      onPress={() => onPressItem(item.id)}
                    >
                      <View className="size-10 items-center justify-center rounded-full bg-subtle">
                        <SymbolView
                          name={item.icon}
                          size={18}
                          tintColor={iconColor}
                          type="monochrome"
                        />
                      </View>
                      <Text className="text-base">{item.title}</Text>
                    </Pressable>
                  ))}
                </View>
              </Animated.View>
            )}
          </View>
        </OverlayPortal>
      )}
    </>
  );
}
