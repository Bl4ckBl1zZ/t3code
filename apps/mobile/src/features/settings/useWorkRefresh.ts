import { useFocusEffect } from "@react-navigation/native";
import { useCallback } from "react";
import { AppState } from "react-native";

/** Refreshes background results only while their screen is visible and the app is active. */
export function useWorkRefresh(refresh: () => void, enabled: boolean, intervalMs = 30_000) {
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      const timer = setInterval(() => {
        if (AppState.currentState === "active") refresh();
      }, intervalMs);
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") refresh();
      });
      return () => {
        clearInterval(timer);
        subscription.remove();
      };
    }, [enabled, intervalMs, refresh]),
  );
}
