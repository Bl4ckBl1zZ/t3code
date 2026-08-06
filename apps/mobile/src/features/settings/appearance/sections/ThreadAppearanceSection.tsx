import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

/**
 * Matches the web client's "Activity detail" setting: a settled turn keeps its
 * tool calls and reasoning in the feed instead of folding them away.
 */
export function ThreadAppearanceSection() {
  const { isReady, appearance, setAlwaysExpandActivity } = useAppearancePreferences();

  return (
    <SettingsSection card title="Threads">
      <SettingsSwitchRow
        disabled={!isReady}
        icon="list.bullet.indent"
        label="Activity detail"
        onValueChange={setAlwaysExpandActivity}
        value={appearance.alwaysExpandActivity}
      />
    </SettingsSection>
  );
}
