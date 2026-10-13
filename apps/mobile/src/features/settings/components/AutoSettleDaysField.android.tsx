import {
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@t3tools/contracts";
import { View } from "react-native";

import { AppText } from "../../../components/AppText";
import { MaterialIconButton } from "../../../components/MaterialIconButton";
import type { AutoSettleDaysFieldProps } from "./AutoSettleDaysField";

export function AutoSettleDaysField(props: AutoSettleDaysFieldProps) {
  const min = props.min ?? MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS;
  const max = props.max ?? MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS;
  const label = props.accessibilityLabel ?? "Days before auto-settle";
  const adjust = (amount: number) => {
    if (props.disabled) return;
    const next = Math.max(min, Math.min(max, props.value + amount));
    if (next !== props.value) props.onValueChange(next);
  };

  return (
    <View className="shrink-0 flex-row items-center">
      {/* Match the 32dp switch track while retaining 48dp button touch targets. */}
      <View
        pointerEvents="none"
        className="absolute inset-x-0 rounded-full bg-subtle"
        style={{ height: 32 }}
      />
      <MaterialIconButton
        icon="minus"
        accessibilityLabel={`Decrease ${label.toLowerCase()}`}
        disabled={props.disabled || props.value <= min}
        onPress={() => adjust(-1)}
      />
      <AppText
        className="min-w-8 text-center text-base"
        style={{ fontVariant: ["tabular-nums"] }}
        accessibilityLabel={
          props.accessibilityLabel === undefined
            ? `${props.value} ${props.value === 1 ? "day" : "days"} before auto-settle`
            : `${label}: ${props.value}`
        }
        accessibilityLiveRegion="polite"
      >
        {props.value}
      </AppText>
      <MaterialIconButton
        icon="plus"
        accessibilityLabel={`Increase ${label.toLowerCase()}`}
        disabled={props.disabled || props.value >= max}
        onPress={() => adjust(1)}
      />
    </View>
  );
}
