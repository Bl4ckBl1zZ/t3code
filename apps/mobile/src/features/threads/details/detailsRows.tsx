import type { ComponentProps, ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { useThemeColor } from "../../../lib/useThemeColor";

/**
 * Row primitives for the thread details sheet.
 *
 * The desktop panel stacks flat rows under small section headings; on a phone
 * the same grouping reads as a card per section, so the heading sits outside
 * the card and the rows are separated by inset hairlines.
 */

export function DetailsSection(props: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly footer?: string | null;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-1.5">
      <View className="min-h-6 flex-row items-center justify-between gap-3 px-1">
        <Text className="text-2xs font-t3-bold uppercase tracking-[0.9px] text-foreground-muted">
          {props.title}
        </Text>
        {props.action}
      </View>
      <View className="overflow-hidden rounded-[20px] border border-border bg-card">
        {props.children}
      </View>
      {props.footer ? (
        <Text className="px-1 text-xs text-foreground-muted">{props.footer}</Text>
      ) : null}
    </View>
  );
}

/** Inset hairline between rows, matching the git sheet's list treatment. */
export function DetailsDivider() {
  return <View className="ml-12 h-px bg-border" />;
}

export function DetailsRow(props: {
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly iconTint?: string;
  /** Replaces the icon puck entirely — used for status dots and agent orbs. */
  readonly leading?: ReactNode;
  readonly title: string;
  readonly titleMono?: boolean;
  readonly subtitle?: string | null;
  readonly detail?: ReactNode;
  readonly disabled?: boolean;
  readonly showChevron?: boolean;
  readonly trailing?: ReactNode;
  readonly onPress?: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const interactive = props.onPress !== undefined && props.disabled !== true;

  return (
    <Pressable
      accessibilityRole={interactive ? "button" : undefined}
      accessibilityState={{ disabled: props.disabled === true }}
      className="min-h-[52px] flex-row items-center gap-3 px-3 py-2.5 disabled:opacity-[0.45]"
      disabled={!interactive}
      onPress={props.onPress}
    >
      {props.leading ?? (
        <View className="h-9 w-9 items-center justify-center rounded-full bg-subtle">
          {props.icon ? (
            <SymbolView
              name={props.icon}
              size={16}
              tintColor={props.iconTint ?? iconColor}
              type="monochrome"
            />
          ) : null}
        </View>
      )}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text
          className={cn(
            "text-foreground",
            props.titleMono ? "font-mono text-xs" : "text-[15px] font-t3-medium",
          )}
          numberOfLines={1}
        >
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={2}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.detail}
      {props.trailing}
      {props.showChevron !== false && interactive && props.trailing === undefined ? (
        <SymbolView name="chevron.right" size={13} tintColor={iconSubtleColor} type="monochrome" />
      ) : null}
    </Pressable>
  );
}

/** Small coloured dot used where a row's state matters more than its icon. */
export function DetailsStatusDot(props: { readonly className: string }) {
  return <View className={cn("h-2 w-2 shrink-0 rounded-full", props.className)} />;
}

/**
 * The warning cards the desktop panel puts at the top of Workspace — an
 * unreachable environment or a client/server version skew. Both are conditions
 * the user has to act on before anything else in the sheet will work.
 */
export function DetailsNotice(props: {
  readonly title: string;
  readonly body: string;
  readonly actions?: ReactNode;
}) {
  const warningColor = String(useThemeColor("--color-danger-foreground"));

  return (
    <View className="flex-row gap-2 rounded-[18px] border border-danger-border bg-danger p-3">
      <View className="pt-0.5">
        <SymbolView
          name="exclamationmark.triangle"
          size={14}
          tintColor={warningColor}
          type="monochrome"
        />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-sm font-t3-semibold text-foreground">{props.title}</Text>
        <Text className="text-xs leading-relaxed text-foreground-muted">{props.body}</Text>
        {props.actions ? <View className="mt-1 flex-row gap-2">{props.actions}</View> : null}
      </View>
    </View>
  );
}

export function DetailsNoticeButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly tone?: "primary" | "plain";
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className={cn(
        "min-h-8 justify-center rounded-full px-3.5",
        props.tone === "primary" ? "bg-primary" : "bg-subtle",
        props.disabled === true && "opacity-[0.45]",
      )}
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <Text
        className={cn(
          "text-xs font-t3-semibold",
          props.tone === "primary" ? "text-primary-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
