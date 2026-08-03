import { LiquidGlassView } from "@callstack/liquid-glass";
import { MenuView } from "@react-native-menu/menu";
import * as Haptics from "expo-haptics";
import {
  cloneElement,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { Platform, Pressable, useColorScheme, View } from "react-native";
import { useThemeColor } from "../lib/useThemeColor";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../native/native-glass";

import { cn } from "../lib/cn";
import { AndroidAnchoredMenu } from "./AndroidAnchoredMenu";
import { AnimatedSymbolSwap, SymbolView } from "./AppSymbol";
import { AppText as Text } from "./AppText";

export function ControlPill(props: {
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly iconNode?: ReactNode;
  /** Morph (zoom-crossfade) between icons when `icon` changes instead of snapping. */
  readonly animateIconChanges?: boolean;
  readonly label?: string;
  readonly accessibilityLabel?: string;
  readonly onPress?: () => void;
  readonly onLongPress?: () => void;
  readonly variant?: "circle" | "pill" | "primary" | "danger";
  readonly disabled?: boolean;
  /**
   * Render the circle as an interactive LiquidGlassView on iOS 26+ so a menu
   * anchored to it presents as glass morphing out of glass. Icon-only circles
   * only; falls back to the standard styling when unsupported.
   */
  readonly glass?: boolean;
}) {
  const variant = props.variant ?? "circle";
  const isDarkMode = useColorScheme() === "dark";

  const iconColor = useThemeColor("--color-icon");
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const primaryFg = useThemeColor("--color-primary-foreground");
  const dangerFg = useThemeColor("--color-danger-foreground");
  const primaryBg = useThemeColor("--color-primary");
  const dangerBg = useThemeColor("--color-danger");
  const iconTintColor =
    variant === "primary"
      ? props.disabled
        ? iconSubtle
        : primaryFg
      : variant === "danger"
        ? dangerFg
        : iconColor;

  const isCircle =
    variant === "circle" || variant === "danger" || (variant === "primary" && !props.label);
  const containerClassName = cn(
    isCircle
      ? "h-11 w-11 items-center justify-center rounded-full"
      : variant === "primary"
        ? "h-11 flex-row items-center justify-center gap-2 rounded-full px-5"
        : "h-11 flex-row items-center justify-center gap-2 rounded-full px-3.5",
    variant === "primary"
      ? props.disabled
        ? "bg-subtle-strong"
        : "bg-primary"
      : variant === "danger"
        ? "bg-danger"
        : "bg-subtle",
  );
  const labelClassName = cn(
    "text-center text-xs font-t3-bold",
    variant === "primary"
      ? props.disabled
        ? "text-foreground-muted"
        : "text-primary-foreground"
      : "",
  );

  if (props.glass && NATIVE_LIQUID_GLASS_SUPPORTED && isCircle) {
    return (
      <LiquidGlassView
        effect="regular"
        interactive
        colorScheme={isDarkMode ? "dark" : "light"}
        tintColor={
          variant === "primary" && !props.disabled
            ? primaryBg
            : variant === "danger"
              ? dangerBg
              : undefined
        }
        style={{
          alignItems: "center",
          borderRadius: 22,
          height: 44,
          justifyContent: "center",
          opacity: props.disabled ? 0.55 : 1,
          width: 44,
        }}
      >
        <Pressable
          accessibilityLabel={props.accessibilityLabel ?? props.label}
          accessibilityRole="button"
          onPress={props.onPress}
          onLongPress={props.onLongPress}
          disabled={props.disabled}
          className="h-11 w-11 items-center justify-center"
        >
          {props.iconNode ? (
            <View className="h-4 w-4 items-center justify-center">{props.iconNode}</View>
          ) : props.icon ? (
            props.animateIconChanges ? (
              <AnimatedSymbolSwap
                name={props.icon}
                size={16}
                tintColor={iconTintColor}
                type="monochrome"
              />
            ) : (
              <SymbolView name={props.icon} size={16} tintColor={iconTintColor} type="monochrome" />
            )
          ) : null}
        </Pressable>
      </LiquidGlassView>
    );
  }

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityRole="button"
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      disabled={props.disabled}
      className={containerClassName}
    >
      {props.iconNode ? (
        <View className="h-4 w-4 items-center justify-center">{props.iconNode}</View>
      ) : props.icon ? (
        props.animateIconChanges ? (
          <AnimatedSymbolSwap
            name={props.icon}
            size={16}
            tintColor={iconTintColor}
            type="monochrome"
          />
        ) : (
          <SymbolView name={props.icon} size={16} tintColor={iconTintColor} type="monochrome" />
        )
      ) : null}
      {props.label ? <Text className={labelClassName}>{props.label}</Text> : null}
    </Pressable>
  );
}

// iOS renders the native UIMenu (standard checkmark for `state: "on"`);
// Android renders the token-styled AndroidAnchoredMenu, since the native
// AppCompat popup can't be themed past its stock animation, metrics, and
// submenu chrome.
export function ControlPillMenu(
  props: Omit<ComponentProps<typeof MenuView>, "children" | "themeVariant"> & {
    readonly children: ReactNode;
    readonly className?: string;
  },
) {
  const isDarkMode = useColorScheme() === "dark";

  if (Platform.OS === "android") {
    // Long-press menus keep their child interactive: the child element gets
    // an injected onLongPress (mirroring the iOS context-menu interaction)
    // so its own tap handling still works.
    if (props.shouldOpenOnLongPress && isValidElement(props.children)) {
      const child = props.children as ReactElement<{ onLongPress?: () => void }>;
      return (
        <AndroidAnchoredMenu
          actions={props.actions}
          className={props.className}
          title={props.title}
          style={props.style}
          onPressAction={props.onPressAction}
        >
          {(open) =>
            cloneElement(child, {
              onLongPress: () => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                open();
              },
            })
          }
        </AndroidAnchoredMenu>
      );
    }
    return (
      <AndroidAnchoredMenu
        actions={props.actions}
        className={props.className}
        title={props.title}
        style={props.style}
        onPressAction={props.onPressAction}
      >
        {props.children}
      </AndroidAnchoredMenu>
    );
  }

  const { className: _className, ...menuProps } = props;
  return (
    <MenuView {...menuProps} themeVariant={isDarkMode ? "dark" : "light"}>
      {menuProps.children}
    </MenuView>
  );
}
