import type { ComponentProps } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";

type SymbolName = ComponentProps<typeof SymbolView>["name"];

/**
 * A system boundary in the transcript: hairline — pill — hairline. Becomes
 * pressable when onAction is set (e.g. "Open source conversation").
 */
export function TimelineSystemDivider(props: {
  readonly label: string;
  readonly detail?: string | null;
  readonly tone?: "neutral" | "danger";
  readonly symbol?: SymbolName;
  readonly actionLabel?: string | null;
  readonly onAction?: () => void;
}) {
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const danger = props.tone === "danger";
  const pressable = props.onAction !== undefined;

  const pill = (
    <View
      className={cn(
        "max-w-[86%] flex-row items-center gap-1.5 rounded-full border px-3 py-1.5",
        danger
          ? "border-red-500/25 bg-red-500/10"
          : "border-neutral-300/50 bg-card dark:border-white/[0.08]",
      )}
    >
      {props.symbol ? (
        <SymbolView
          name={props.symbol}
          size={11}
          tintColor={danger ? "#ef4444" : iconSubtle}
          type="monochrome"
        />
      ) : null}
      <Text
        className={cn(
          "shrink-0 font-t3-medium text-2xs",
          danger ? "text-red-600 dark:text-red-400" : "text-foreground-muted",
        )}
        numberOfLines={1}
      >
        {props.label}
      </Text>
      {props.detail ? (
        <Text className="shrink text-2xs text-foreground-muted opacity-70" numberOfLines={1}>
          {props.detail}
        </Text>
      ) : null}
      {pressable ? (
        <SymbolView name="arrow.right" size={10} tintColor={iconSubtle} type="monochrome" />
      ) : null}
    </View>
  );

  return (
    <View className="mb-4 flex-row items-center gap-2.5">
      <View className="h-px flex-1 bg-neutral-300/50 dark:bg-white/[0.08]" />
      {pressable ? (
        <Pressable
          accessibilityLabel={props.actionLabel ?? props.label}
          accessibilityRole="button"
          onPress={props.onAction}
        >
          {pill}
        </Pressable>
      ) : (
        pill
      )}
      <View className="h-px flex-1 bg-neutral-300/50 dark:bg-white/[0.08]" />
    </View>
  );
}
