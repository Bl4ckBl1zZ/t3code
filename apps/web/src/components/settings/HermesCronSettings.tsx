import { HermesWorkManager } from "../HermesWorkManager";
import { SettingsPageContainer } from "./settingsLayout";

export function HermesCronSettings() {
  return (
    <SettingsPageContainer className="max-w-5xl">
      <HermesWorkManager initialSection="schedules" />
    </SettingsPageContainer>
  );
}
