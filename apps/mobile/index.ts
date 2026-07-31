import { registerRootComponent } from "expo";
import "react-native-gesture-handler";
import { LogBox } from "react-native";
import { featureFlags } from "react-native-screens";

import App from "./src/App";

// Required for react-native-screens' iOS FormSheet sizing fix when a nested
// native stack is rendered inside a non-fitToContents formSheet.
featureFlags.experiment.synchronousScreenUpdatesEnabled = true;

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  LogBox.ignoreAllLogs();
}

registerRootComponent(App);

// TEMP voice capture debug hook — local repro only, do not commit.
setTimeout(() => {
  void (async () => {
    const report = async (payload: unknown) => {
      try {
        await fetch("http://192.168.178.55:18930/report", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch {
        // Receiver not listening.
      }
    };
    try {
      const { MobileVoiceCapture } = await import("./src/features/voice/MobileVoiceCapture");
      const capture = new MobileVoiceCapture();
      const permission = await capture.requestPermission(new AbortController().signal);
      if (permission !== "granted") {
        await report({ error: `permission ${permission}` });
        return;
      }
      const levels: number[] = [];
      await capture.start({
        signal: new AbortController().signal,
        onLevel: (level: number) => levels.push(level),
      });
      await new Promise((resolve) => setTimeout(resolve, 4000));
      const recording = await capture.stop();
      await report({
        format: recording.format,
        durationSeconds: recording.durationSeconds,
        base64Length: recording.data.length,
        levels: levels.slice(0, 10),
        data: recording.data,
      });
    } catch (error) {
      await report({ error: String(error) });
    }
  })();
}, 5000);
