import { BlurView } from "expo-blur";
import { Platform, Pressable, StyleSheet } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";

/** A round control that sits over camera frames and photos, so it is dark in every theme. */
export function ComposerOverlayButton(props: {
  readonly accessibilityLabel: string;
  readonly symbol: AppSymbolName;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      className="size-[48px] items-center justify-center overflow-hidden rounded-full bg-black/45 active:opacity-70"
    >
      {Platform.OS === "ios" ? (
        <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
      ) : null}
      <SymbolView name={props.symbol} size={20} weight="semibold" tintColor="#ffffff" />
    </Pressable>
  );
}
