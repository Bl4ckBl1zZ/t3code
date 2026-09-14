import { HermesWorkManager } from "../HermesWorkManager";
import { SettingsPageContainer } from "./settingsLayout";

export function HermesSkillsSettings() {
  return (
    <SettingsPageContainer className="max-w-5xl">
      <HermesWorkManager initialSection="skills" />
    </SettingsPageContainer>
  );
}
