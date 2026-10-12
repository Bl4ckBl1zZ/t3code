import { useAtomValue } from "@effect/atom-react";
import { useRef } from "react";
import type { SourceControlWritingStyleMode } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import {
  resolveReviewGuideModelSelection,
  resolveSourceControlWriterModelSelection,
} from "@t3tools/shared/serverSettings";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { BranchNamingSettings } from "./BranchNamingSettings";

const MODE_OPTIONS: Record<SourceControlWritingStyleMode, { label: string; description: string }> =
  {
    repo_conventions: {
      label: "Repository conventions",
      description: "In each project, matches recent change descriptions and change request titles.",
    },
    conventional_commits: {
      label: "Conventional Commits",
      description:
        "Uses Conventional Commit prefixes for change descriptions; change request titles and descriptions stay concise.",
    },
    custom: {
      label: "Custom instructions",
      description:
        "Applies your instructions to change descriptions and change request titles and descriptions in every project.",
    },
  };

export function SourceControlWritingSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const customInstructionsRef = useRef<HTMLTextAreaElement>(null);
  const style = settings.sourceControlWritingStyle;
  const defaults = DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle;
  const isSourceControlWritingStyleDirty =
    style.mode !== defaults.mode || style.customInstructions !== defaults.customInstructions;

  const defaultModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const usesDedicatedModel = settings.sourceControlWriterModelSelection !== null;
  // Machine-wide settings: no project is in scope here.
  const resolvedSourceControlWriterSelection = resolveSourceControlWriterModelSelection(
    settings,
    serverProviders,
    null,
  );
  const activeSelection =
    resolvedSourceControlWriterSelection === settings.textGenerationModelSelection
      ? defaultModelSelection
      : resolvedSourceControlWriterSelection;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings, null),
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    activeSelection.instanceId,
    activeSelection.model,
  );
  const writerInstanceEntry = instanceEntries.find(
    (entry) => entry.instanceId === activeSelection.instanceId,
  );
  const usesReviewGuideModel = settings.reviewGuideModelSelection !== null;
  const reviewGuideSelection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolveReviewGuideModelSelection(
        settings,
        serverProviders,
        null,
      ),
    },
    serverProviders,
  );
  // Its own list: a custom model chosen for guides is not among the writer model's options.
  const reviewGuideModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    reviewGuideSelection.instanceId,
    reviewGuideSelection.model,
  );
  const reviewGuideInstanceEntry = instanceEntries.find(
    (entry) => entry.instanceId === reviewGuideSelection.instanceId,
  );

  return (
    <SettingsSection title="Text generation">
      <BranchNamingSettings />
      <SettingsRow
        serverScoped
        title="Source control writing style"
        description={MODE_OPTIONS[style.mode].description}
        resetAction={
          isSourceControlWritingStyleDirty ? (
            <SettingResetButton
              label="source control writing style"
              onClick={() =>
                updateSettings({
                  sourceControlWritingStyle: {
                    mode: defaults.mode,
                    customInstructions: defaults.customInstructions,
                  },
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={style.mode}
            onValueChange={(value) => {
              const customInstructions = customInstructionsRef.current?.value.trim();
              updateSettings({
                sourceControlWritingStyle: {
                  mode: value as SourceControlWritingStyleMode,
                  ...(customInstructions !== undefined ? { customInstructions } : {}),
                },
              });
            }}
          >
            <SelectTrigger className="w-full sm:w-56" aria-label="Source control writing style">
              <SelectValue>{MODE_OPTIONS[style.mode].label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(MODE_OPTIONS) as SourceControlWritingStyleMode[]).map((mode) => (
                <SelectItem key={mode} hideIndicator value={mode}>
                  {MODE_OPTIONS[mode].label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      >
        {style.mode === "custom" ? (
          <div className="mt-3 max-w-2xl pb-3.5">
            <Textarea
              key={style.customInstructions}
              ref={customInstructionsRef}
              defaultValue={style.customInstructions}
              onBlur={(event) => {
                const customInstructions = event.target.value.trim();
                if (customInstructions !== style.customInstructions) {
                  updateSettings({ sourceControlWritingStyle: { customInstructions } });
                }
              }}
              rows={4}
              placeholder="Keep titles concise. Use short bullet points in descriptions."
              aria-label="Custom source control writing instructions"
            />
          </div>
        ) : null}
      </SettingsRow>

      <SettingsRow
        serverScoped
        title="Follow change request templates"
        description="Structures change request descriptions using the current repository's template when one is available."
        resetAction={
          style.followChangeRequestTemplates !== defaults.followChangeRequestTemplates ? (
            <SettingResetButton
              label="change request templates"
              onClick={() =>
                updateSettings({
                  sourceControlWritingStyle: {
                    followChangeRequestTemplates: defaults.followChangeRequestTemplates,
                  },
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={style.followChangeRequestTemplates}
            onCheckedChange={(checked) =>
              updateSettings({
                sourceControlWritingStyle: {
                  followChangeRequestTemplates: Boolean(checked),
                },
              })
            }
            aria-label="Follow change request templates"
          />
        }
      />

      <SettingsRow
        serverScoped
        title="Source control writer model"
        description="Optional model override for change descriptions, change request titles and descriptions, and branch or bookmark names. Off uses the global text generation model."
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {usesDedicatedModel ? (
              <ProviderModelPicker
                environmentId={primaryEnvironmentId}
                activeInstanceId={activeSelection.instanceId}
                model={activeSelection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                triggerAriaLabel="Source control writer model"
                onInstanceModelChange={(instanceId, model) => {
                  updateSettings({
                    sourceControlWriterModelSelection: createModelSelection(instanceId, model),
                  });
                }}
              />
            ) : null}
            {usesDedicatedModel && writerInstanceEntry ? (
              <TraitsPicker
                provider={writerInstanceEntry.driverKind}
                models={writerInstanceEntry.models}
                model={activeSelection.model}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={activeSelection.options ?? []}
                allowPromptInjectedEffort={false}
                planModeEnabled={
                  settings.planModeEnabled || selectsPlanAgent(activeSelection.options)
                }
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onModelOptionsChange={(options) =>
                  updateSettings({
                    sourceControlWriterModelSelection: createModelSelection(
                      activeSelection.instanceId,
                      activeSelection.model,
                      options,
                    ),
                  })
                }
              />
            ) : null}
            <Switch
              checked={usesDedicatedModel}
              onCheckedChange={(checked) =>
                updateSettings({
                  sourceControlWriterModelSelection: checked
                    ? createModelSelection(
                        defaultModelSelection.instanceId,
                        defaultModelSelection.model,
                        defaultModelSelection.options,
                      )
                    : null,
                })
              }
              aria-label="Use a separate source control writer model"
            />
          </div>
        }
      />

      {/* A beta the server owns: off hides the Guide tab in every client and refuses agents. */}
      <SettingsRow
        serverScoped
        {...searchableSetting("review-guides")}
        description="Adds a Guide tab to pull requests: an agent writes a tour of the change, stop by stop, with the calls a maintainer should make."
        control={
          <Switch
            checked={settings.reviewGuidesEnabled}
            onCheckedChange={(checked) => updateSettings({ reviewGuidesEnabled: Boolean(checked) })}
            aria-label="Review guides"
          />
        }
      />

      {settings.reviewGuidesEnabled ? (
        <>
          <SettingsRow
            serverScoped
            {...searchableSetting("review-guide-model")}
            description="Model that reads a pull request to write its review guide. It reads the change itself over many steps, so a stronger model helps. Off uses the source control writer model."
            control={
              <div className="flex flex-wrap items-center justify-end gap-2">
                {usesReviewGuideModel ? (
                  <ProviderModelPicker
                    environmentId={primaryEnvironmentId}
                    activeInstanceId={reviewGuideSelection.instanceId}
                    model={reviewGuideSelection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={reviewGuideModelOptionsByInstance}
                    triggerVariant="outline"
                    triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                    triggerAriaLabel="Review guide model"
                    onInstanceModelChange={(instanceId, model) => {
                      updateSettings({
                        reviewGuideModelSelection: createModelSelection(instanceId, model),
                      });
                    }}
                  />
                ) : null}
                {usesReviewGuideModel && reviewGuideInstanceEntry ? (
                  <TraitsPicker
                    provider={reviewGuideInstanceEntry.driverKind}
                    models={reviewGuideInstanceEntry.models}
                    model={reviewGuideSelection.model}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={reviewGuideSelection.options ?? []}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={
                      settings.planModeEnabled || selectsPlanAgent(reviewGuideSelection.options)
                    }
                    triggerVariant="outline"
                    triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                    onModelOptionsChange={(options) =>
                      updateSettings({
                        reviewGuideModelSelection: createModelSelection(
                          reviewGuideSelection.instanceId,
                          reviewGuideSelection.model,
                          options,
                        ),
                      })
                    }
                  />
                ) : null}
                <Switch
                  checked={usesReviewGuideModel}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      reviewGuideModelSelection: checked
                        ? createModelSelection(
                            activeSelection.instanceId,
                            activeSelection.model,
                            activeSelection.options,
                          )
                        : null,
                    })
                  }
                  aria-label="Use a separate review guide model"
                />
              </div>
            }
          />

          <SettingsRow
            serverScoped
            {...searchableSetting("review-guide-instructions")}
            description="Your preferences for review guides: what to show first, dwell on, or skip. The guide's format and coverage stay the same."
            resetAction={
              settings.reviewGuideInstructions !== "" ? (
                <SettingResetButton
                  label="review guide instructions"
                  onClick={() => updateSettings({ reviewGuideInstructions: "" })}
                />
              ) : null
            }
          >
            <div className="mt-3 max-w-2xl pb-3.5">
              <Textarea
                key={settings.reviewGuideInstructions}
                aria-label="Review guide instructions"
                rows={4}
                defaultValue={settings.reviewGuideInstructions}
                placeholder="Show service interfaces before implementations. Skip test files unless they change behavior. Keep summaries to two sentences."
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (value !== settings.reviewGuideInstructions)
                    updateSettings({ reviewGuideInstructions: value });
                }}
              />
            </div>
          </SettingsRow>
        </>
      ) : null}
    </SettingsSection>
  );
}
