import type { ServerSettingsPatch } from "@t3tools/contracts";
import {
  DEFAULT_UNIFIED_SETTINGS,
  type WorktreeRetentionSettings,
} from "@t3tools/contracts/settings";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";

import { ensureLocalApi, readLocalApi } from "../../localApi";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const WORKTREE_RETENTION_DAY_MS = 24 * 60 * 60 * 1_000;
const WORKTREE_RETENTION_HOUR_MS = 60 * 60 * 1_000;

function durationToWholeUnits(duration: Duration.Duration, unitMs: number, minimum = 1): number {
  return Math.max(minimum, Math.round(Duration.toMillis(duration) / unitMs));
}

function positiveDurationFromUnits(value: number | null, unitMs: number): Duration.Duration {
  const units = value === null || !Number.isFinite(value) ? 1 : Math.max(1, Math.round(value));
  return Duration.millis(units * unitMs);
}

export function WorktreeRetentionSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const retention = settings.worktreeRetention;
  const retentionDefaults = DEFAULT_UNIFIED_SETTINGS.worktreeRetention;
  const updateRetention = (patch: NonNullable<ServerSettingsPatch["worktreeRetention"]>) =>
    updateSettings({ worktreeRetention: patch });

  const setMode = (mode: WorktreeRetentionSettings["mode"] | null) => {
    if (mode === null) return;
    if (mode !== "delete") {
      updateRetention({ mode });
      return;
    }
    void (async () => {
      const confirmed = await (readLocalApi() ?? ensureLocalApi()).dialogs.confirm(
        [
          "Enable automatic worktree deletion?",
          "This permanently removes qualifying clean, inactive, unshared Git worktrees. Start with Report mode and review the server logs before enabling Delete mode.",
        ].join("\n"),
        { variant: "destructive" },
      );
      if (confirmed) updateRetention({ mode: "delete" });
    })();
  };

  const maxAgeDays =
    retention.maxAge === null
      ? null
      : durationToWholeUnits(retention.maxAge, WORKTREE_RETENTION_DAY_MS);
  const staleAfterDays =
    retention.staleAfter === null
      ? null
      : durationToWholeUnits(retention.staleAfter, WORKTREE_RETENTION_DAY_MS);
  const scanIntervalHours = durationToWholeUnits(
    retention.scanInterval,
    WORKTREE_RETENTION_HOUR_MS,
  );

  return (
    <>
      <SettingsRow
        {...searchableSetting("worktree-retention")}
        title="Worktree retention"
        description="Let the server report or remove old worktrees. It only considers clean, inactive, unshared worktrees that are safely identified as Git worktrees. Unknown state is skipped."
        resetAction={
          Equal.equals(retention, retentionDefaults) ? null : (
            <SettingResetButton
              label="worktree retention"
              onClick={() => updateRetention(retentionDefaults)}
            />
          )
        }
        control={
          <Select value={retention.mode} onValueChange={setMode}>
            <SelectTrigger className="w-full sm:w-32" aria-label="Worktree retention mode">
              <SelectValue>
                {retention.mode === "off"
                  ? "Off"
                  : retention.mode === "report"
                    ? "Report"
                    : "Delete"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="off">
                Off
              </SelectItem>
              <SelectItem hideIndicator value="report">
                Report only
              </SelectItem>
              <SelectItem hideIndicator value="delete">
                Delete
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        className="bg-muted/20 sm:pl-9"
        title="Maximum age"
        description="Delete or report a worktree once it is older than this. Leave disabled to omit the age rule."
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Switch
              checked={maxAgeDays !== null}
              onCheckedChange={(checked) =>
                updateRetention({
                  maxAge: checked ? Duration.days(maxAgeDays ?? 30) : null,
                })
              }
              aria-label="Enable maximum worktree age"
            />
            {maxAgeDays !== null ? (
              <NumberField
                value={maxAgeDays}
                min={1}
                step={1}
                size="sm"
                className="w-28"
                onValueChange={(value) =>
                  updateRetention({
                    maxAge: positiveDurationFromUnits(value, WORKTREE_RETENTION_DAY_MS),
                  })
                }
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement aria-label="Decrease maximum worktree age" />
                  <NumberFieldInput aria-label="Maximum worktree age in days" />
                  <NumberFieldIncrement aria-label="Increase maximum worktree age" />
                </NumberFieldGroup>
              </NumberField>
            ) : null}
            {maxAgeDays !== null ? (
              <span className="text-xs text-muted-foreground">days</span>
            ) : null}
          </div>
        }
      />

      <SettingsRow
        className="bg-muted/20 sm:pl-9"
        title="Inactive for"
        description="Delete or report a worktree after this long without observed activity. Leave disabled to omit the inactivity rule."
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Switch
              checked={staleAfterDays !== null}
              onCheckedChange={(checked) =>
                updateRetention({
                  staleAfter: checked ? Duration.days(staleAfterDays ?? 14) : null,
                })
              }
              aria-label="Enable inactive worktree age"
            />
            {staleAfterDays !== null ? (
              <NumberField
                value={staleAfterDays}
                min={1}
                step={1}
                size="sm"
                className="w-28"
                onValueChange={(value) =>
                  updateRetention({
                    staleAfter: positiveDurationFromUnits(value, WORKTREE_RETENTION_DAY_MS),
                  })
                }
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement aria-label="Decrease inactive worktree age" />
                  <NumberFieldInput aria-label="Inactive worktree age in days" />
                  <NumberFieldIncrement aria-label="Increase inactive worktree age" />
                </NumberFieldGroup>
              </NumberField>
            ) : null}
            {staleAfterDays !== null ? (
              <span className="text-xs text-muted-foreground">days</span>
            ) : null}
          </div>
        }
      />

      <SettingsRow
        className="bg-muted/20 sm:pl-9"
        title="Delete after pull request merge"
        description="When enabled, a merged pull request is an additional deletion rule. It still must pass every safety check."
        control={
          <Switch
            checked={retention.deleteOnPullRequestMerge}
            onCheckedChange={(checked) =>
              updateRetention({ deleteOnPullRequestMerge: Boolean(checked) })
            }
            aria-label="Delete worktrees after pull request merge"
          />
        }
      />

      <SettingsRow
        className="bg-muted/20 sm:pl-9"
        title="Scan interval"
        description="How often the server evaluates the retention policy while it is running."
        control={
          <div className="flex items-center justify-end gap-2">
            <NumberField
              value={scanIntervalHours}
              min={1}
              max={168}
              step={1}
              size="sm"
              className="w-28"
              onValueChange={(value) =>
                updateRetention({
                  scanInterval: positiveDurationFromUnits(value, WORKTREE_RETENTION_HOUR_MS),
                })
              }
            >
              <NumberFieldGroup>
                <NumberFieldDecrement aria-label="Decrease worktree retention scan interval" />
                <NumberFieldInput aria-label="Worktree retention scan interval in hours" />
                <NumberFieldIncrement aria-label="Increase worktree retention scan interval" />
              </NumberFieldGroup>
            </NumberField>
            <span className="text-xs text-muted-foreground">hours (1–168)</span>
          </div>
        }
      />
    </>
  );
}
