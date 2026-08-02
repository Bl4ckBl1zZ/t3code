import type { ComponentProps } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

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
  /** Stacked puts the detail on its own centered line under the label. */
  readonly layout?: "inline" | "stacked";
  /** In-flight system work: swaps the symbol for a spinner. */
  readonly busy?: boolean;
  readonly actionLabel?: string | null;
  readonly onAction?: () => void;
}) {
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const danger = props.tone === "danger";
  const pressable = props.onAction !== undefined;
  const stacked = props.layout === "stacked";

  const icon = props.busy ? (
    // iOS only accepts "small"/"large"; scale the 20px small spinner down to
    // match the 11px symbol footprint.
    <ActivityIndicator
      size="small"
      color={danger ? "#ef4444" : iconSubtle}
      style={{ width: 11, height: 11, transform: [{ scale: 0.55 }] }}
    />
  ) : props.symbol ? (
    <SymbolView
      name={props.symbol}
      size={11}
      tintColor={danger ? "#ef4444" : iconSubtle}
      type="monochrome"
    />
  ) : null;
  const labelText = (
    <Text
      className={cn(
        "shrink-0 font-t3-medium text-2xs",
        danger ? "text-red-600 dark:text-red-400" : "text-foreground-muted",
      )}
      numberOfLines={1}
    >
      {props.label}
    </Text>
  );
  const detailText = props.detail ? (
    <Text className="shrink text-2xs text-foreground-muted opacity-70" numberOfLines={1}>
      {props.detail}
    </Text>
  ) : null;

  const pill = (
    <View
      className={cn(
        "max-w-[86%] rounded-full border",
        stacked
          ? "items-center gap-0.5 rounded-[14px] px-3.5 py-2"
          : "flex-row items-center gap-1.5 px-3 py-1.5",
        danger
          ? "border-red-500/25 bg-red-500/10"
          : "border-neutral-300/50 bg-card dark:border-white/[0.08]",
      )}
    >
      {stacked ? (
        <>
          <View className="flex-row items-center gap-1.5">
            {icon}
            {labelText}
          </View>
          {detailText}
        </>
      ) : (
        <>
          {icon}
          {labelText}
          {detailText}
        </>
      )}
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
