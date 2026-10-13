import { createFileRoute } from "@tanstack/react-router";

import { VoiceInputSettingsPanel } from "../components/settings/VoiceInputSettings";

export const Route = createFileRoute("/settings/voice-input")({
  component: VoiceInputSettingsPanel,
});
