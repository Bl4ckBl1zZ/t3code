import type { ComponentProps } from "react";
import { ActivityIndicator, Pressable } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { useThemeColor } from "../../../lib/useThemeColor";

type SymbolName = ComponentProps<typeof SymbolView>["name"];

/**
 * Action button for settings sheets, styled from the tokens that actually exist
 * in global.css (primary / secondary / danger). Disabled opacity is applied on
 * the className directly because the `disabled:` variant keys off DOM
 * attributes that a Pressable never sets.
 */
export function SettingsActionButton(props: {
  readonly icon?: SymbolName;
  readonly label: string;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly tone?: "primary" | "secondary" | "danger";
  readonly onPress: () => void;
}) {
  const tone = props.tone ?? "secondary";
  const primaryForeground = useThemeColor("--color-primary-foreground");
  const dangerForeground = useThemeColor("--color-danger-foreground");
  const secondaryForeground = useThemeColor("--color-secondary-foreground");
  const foreground =
    tone === "primary"
      ? primaryForeground
      : tone === "danger"
        ? dangerForeground
        : secondaryForeground;
  const disabled = props.disabled === true || props.busy === true;

  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ busy: props.busy ?? false, disabled }}
      className={cn(
        "min-h-[48px] flex-row items-center justify-center gap-2 rounded-[16px] px-4 py-3",
        tone === "primary"
          ? "bg-primary"
          : tone === "danger"
            ? "border border-danger-border bg-danger"
            : "border border-border bg-secondary",
        disabled && "opacity-[0.45]",
      )}
      disabled={disabled}
      onPress={props.onPress}
    >
      {props.busy ? (
        <ActivityIndicator color={foreground} size="small" />
      ) : props.icon ? (
        <SymbolView name={props.icon} size={14} tintColor={foreground} type="monochrome" />
      ) : null}
      <Text
        className={cn(
          "text-xs font-t3-bold tracking-[0.8px] uppercase",
          tone === "primary"
            ? "text-primary-foreground"
            : tone === "danger"
              ? "text-danger-foreground"
              : "text-secondary-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
