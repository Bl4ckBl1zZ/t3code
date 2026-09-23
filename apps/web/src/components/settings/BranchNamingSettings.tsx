import { useRef } from "react";
import { BranchNamingMode, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingResetButton } from "./settingsLayout";

const MODES = {
  static: "Static prefix",
  semantic: "Semantic prefix",
  custom: "Custom instructions",
} satisfies Record<BranchNamingMode, string>;

export function BranchNamingSettings() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const prefixEdited = useRef(false);
  const instructionsEdited = useRef(false);

  return (
    <>
      <SettingsRow
        serverScoped
        id="worktree-branch-naming"
        title="Worktree branch naming"
        description="Choose how new worktree branches are named from your first message."
        resetAction={
          settings.branchNamingMode !== DEFAULT_SERVER_SETTINGS.branchNamingMode ? (
            <SettingResetButton
              label="branch naming"
              onClick={() =>
                updateSettings({ branchNamingMode: DEFAULT_SERVER_SETTINGS.branchNamingMode })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.branchNamingMode}
            onValueChange={(value) => {
              if (BranchNamingMode.literals.includes(value as BranchNamingMode)) {
                updateSettings({ branchNamingMode: value as BranchNamingMode });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-56" aria-label="Worktree branch naming">
              <SelectValue>{MODES[settings.branchNamingMode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {BranchNamingMode.literals.map((mode) => (
                <SelectItem key={mode} hideIndicator value={mode}>
                  {MODES[mode]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {settings.branchNamingMode === "static" ? (
        <SettingsRow
          serverScoped
          title="Branch prefix"
          description="For example, t3code or t3code/ produces t3code/add-search. Leave empty for no prefix."
          resetAction={
            settings.branchNamePrefix !== DEFAULT_SERVER_SETTINGS.branchNamePrefix ? (
              <SettingResetButton
                label="branch prefix"
                onClick={() =>
                  updateSettings({ branchNamePrefix: DEFAULT_SERVER_SETTINGS.branchNamePrefix })
                }
              />
            ) : null
          }
          control={
            <Input
              key={settings.branchNamePrefix}
              aria-label="Branch prefix"
              autoCapitalize="none"
              spellCheck={false}
              onChange={() => {
                prefixEdited.current = true;
              }}
              placeholder="No prefix"
              defaultValue={settings.branchNamePrefix}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (prefixEdited.current && value !== settings.branchNamePrefix) {
                  updateSettings({ branchNamePrefix: value });
                }
                prefixEdited.current = false;
              }}
            />
          }
        />
      ) : null}
      {settings.branchNamingMode === "semantic" ? (
        <p className="pb-3 text-sm text-muted-foreground">
          The model chooses a prefix that describes the work, such as feat/add-search,
          fix/login-timeout, or refactor/auth.
        </p>
      ) : null}
      {settings.branchNamingMode === "custom" ? (
        <SettingsRow
          serverScoped
          title="Branch naming instructions"
          description="Appended to the naming prompt. The model returns the complete branch name; no prefix or suffix is added."
          resetAction={
            settings.branchNameInstructions !== "" ? (
              <SettingResetButton
                label="branch naming instructions"
                onClick={() => updateSettings({ branchNameInstructions: "" })}
              />
            ) : null
          }
        >
          <div className="mt-3 max-w-2xl pb-3.5">
            <Textarea
              key={settings.branchNameInstructions}
              aria-label="Branch naming instructions"
              onChange={() => {
                instructionsEdited.current = true;
              }}
              rows={4}
              defaultValue={settings.branchNameInstructions}
              placeholder="Use julius/ followed by the issue ID and a short description."
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (instructionsEdited.current && value !== settings.branchNameInstructions) {
                  updateSettings({ branchNameInstructions: value });
                }
                instructionsEdited.current = false;
              }}
            />
          </div>
        </SettingsRow>
      ) : null}
    </>
  );
}
