import { type OpenRouterModelOption } from "@t3tools/contracts/voice";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, PencilIcon, SearchIcon } from "lucide-react";

import { ClaudeAI, Gemini, GrokIcon, type Icon, OpenAI } from "../Icons";
import { providerInstanceInitials } from "../chat/ProviderInstanceIcon";
import { scoreModelPickerSearch } from "../chat/modelPickerSearch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxListVirtualized,
} from "../ui/combobox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

/**
 * OpenRouter model ids are `author/model-slug`. The author segment is the
 * grouping key for the provider rail — icons and display-name overrides are
 * keyed by it; anything unknown falls back to the relay-provided
 * `providerName` plus an initials glyph.
 */
const VOICE_PROVIDER_ICON_BY_AUTHOR: Record<string, Icon> = {
  openai: OpenAI,
  google: Gemini,
  anthropic: ClaudeAI,
  "x-ai": GrokIcon,
};

const VOICE_PROVIDER_NAME_BY_AUTHOR: Record<string, string> = {
  openai: "OpenAI",
  "x-ai": "xAI",
  mistralai: "Mistral AI",
  "meta-llama": "Meta",
};

type VoiceProviderGroup = {
  key: string;
  displayName: string;
  models: OpenRouterModelOption[];
};

function providerKeyForModelId(modelId: string): string {
  return modelId.split("/")[0] ?? modelId;
}

/**
 * OpenRouter model names repeat the author ("Google: Gemini 2.5 Flash").
 * The picker shows the provider on its own line, so drop the prefix.
 */
function stripProviderPrefix(name: string): string {
  const match = name.match(/^[^:]{1,40}:\s+(.+)$/);
  return match ? match[1]! : name;
}

function VoiceProviderGlyph(props: { group: VoiceProviderGroup; className?: string }) {
  const ProviderIcon = VOICE_PROVIDER_ICON_BY_AUTHOR[props.group.key] ?? null;
  if (ProviderIcon) {
    return <ProviderIcon className={cn("size-5 shrink-0", props.className)} aria-hidden />;
  }
  return (
    <span className={cn("text-[10px] font-semibold leading-none", props.className)} aria-hidden>
      {providerInstanceInitials(props.group.displayName)}
    </span>
  );
}

function VoiceModelRow(props: {
  index: number;
  model: OpenRouterModelOption;
  group: VoiceProviderGroup;
}) {
  return (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={props.model.id}
      contentClassName="flex w-full items-center gap-3"
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer rounded-md px-2 py-2 transition-[background-color,box-shadow,color]",
        "hover:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))] data-highlighted:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))] data-selected:bg-foreground/[0.08] data-selected:text-foreground data-selected:ring-0 [&[data-highlighted][data-selected]]:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))]",
      )}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="min-w-0 truncate text-xs font-medium leading-snug">
          {stripProviderPrefix(props.model.name)}
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <VoiceProviderGlyph group={props.group} className="size-3 text-[7px]" />
          <span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">
            {props.group.displayName}
          </span>
        </div>
      </div>
    </ComboboxItem>
  );
}

function VoiceModelPickerContent(props: {
  models: ReadonlyArray<OpenRouterModelOption>;
  value: string;
  isCustom: boolean;
  onSelect: (modelId: string) => void;
  onSelectCustom: () => void;
  onRequestClose: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => {
    const byKey = new Map<string, VoiceProviderGroup>();
    for (const model of props.models) {
      const key = providerKeyForModelId(model.id);
      let group = byKey.get(key);
      if (!group) {
        group = {
          key,
          displayName: VOICE_PROVIDER_NAME_BY_AUTHOR[key] ?? model.providerName,
          models: [],
        };
        byKey.set(key, group);
      }
      group.models.push(model);
    }
    return [...byKey.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [props.models]);

  const groupByKey = useMemo(() => new Map(groups.map((group) => [group.key, group])), [groups]);

  const [selectedProviderKey, setSelectedProviderKey] = useState<string>(() => {
    const currentKey = providerKeyForModelId(props.value);
    return groupByKey.has(currentKey) ? currentKey : (groups[0]?.key ?? "");
  });

  useLayoutEffect(() => {
    searchInputRef.current?.focus({ preventScroll: true });
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const isSearching = searchQuery.trim().length > 0;

  // Search ranks across every provider (like the chat picker); browsing
  // shows only the provider selected in the rail.
  const visibleModels = useMemo(() => {
    if (isSearching) {
      return props.models
        .map((model) => {
          const group = groupByKey.get(providerKeyForModelId(model.id))!;
          return {
            model,
            score: scoreModelPickerSearch(
              {
                name: stripProviderPrefix(model.name),
                shortName: model.id,
                driverKind: group.key,
                providerDisplayName: group.displayName,
              },
              searchQuery,
            ),
          };
        })
        .filter(
          (ranked): ranked is { model: OpenRouterModelOption; score: number } =>
            ranked.score !== null,
        )
        .toSorted((a, b) => a.score - b.score || a.model.name.localeCompare(b.model.name))
        .map((ranked) => ranked.model);
    }
    return groupByKey.get(selectedProviderKey)?.models ?? [];
  }, [groupByKey, isSearching, props.models, searchQuery, selectedProviderKey]);

  const allModelIds = useMemo(() => props.models.map((model) => model.id), [props.models]);
  const visibleModelIds = useMemo(() => visibleModels.map((model) => model.id), [visibleModels]);
  const showSidebar = !isSearching && groups.length > 0;

  return (
    <TooltipProvider delay={0}>
      <div className="dropdown-glass model-picker-surface relative flex h-screen max-h-86.5 w-screen max-w-90 flex-row overflow-hidden rounded-lg text-popover-foreground [clip-path:inset(0_round_var(--radius-lg))]">
        {/* Provider rail */}
        {showSidebar ? (
          <div className="w-11 shrink-0 overflow-hidden bg-muted/30">
            <div className="h-full overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="relative flex min-h-full flex-col gap-1 p-1">
                {groups.map((group) => {
                  const isSelected = selectedProviderKey === group.key;
                  return (
                    <div key={group.key} className="relative w-full">
                      {isSelected ? (
                        <div
                          className="pointer-events-none absolute right-0 top-1/2 z-10 h-5 w-0.75 -translate-y-1/2 rounded-l-full bg-primary"
                          aria-hidden
                        />
                      ) : null}
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              className="relative isolate flex aspect-square w-full cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))] focus-visible:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))] focus-visible:outline-none"
                              onClick={() => {
                                setSelectedProviderKey(group.key);
                                window.requestAnimationFrame(() => {
                                  searchInputRef.current?.focus({ preventScroll: true });
                                });
                              }}
                              type="button"
                              aria-label={group.displayName}
                            />
                          }
                        >
                          <VoiceProviderGlyph group={group} />
                        </TooltipTrigger>
                        <TooltipPopup
                          side="left"
                          sideOffset={8}
                          align="center"
                          className="max-w-64 text-balance font-normal leading-snug"
                        >
                          {group.displayName}
                        </TooltipPopup>
                      </Tooltip>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}

        <Combobox
          inline
          items={allModelIds}
          filteredItems={visibleModelIds}
          filter={null}
          autoHighlight
          open
          value={props.isCustom ? null : props.value}
          onValueChange={(modelId) => {
            if (typeof modelId === "string") {
              props.onSelect(modelId);
            }
          }}
        >
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40",
              showSidebar && "border-l border-border/70",
            )}
          >
            {/* Search bar */}
            <div className="px-2 pt-2">
              <div className="border-b border-border/70 pb-2.5 transition-colors focus-within:border-ring">
                <ComboboxInput
                  ref={searchInputRef}
                  className="[&_input]:h-6.5 [&_input]:font-sans [&_input]:leading-6.5"
                  inputClassName="rounded-none bg-transparent text-sm"
                  placeholder="Search models..."
                  showTrigger={false}
                  startAddon={
                    <SearchIcon className="-translate-x-0.5 size-4 shrink-0 text-muted-foreground opacity-70" />
                  }
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      props.onRequestClose();
                      return;
                    }
                    event.stopPropagation();
                  }}
                  size="sm"
                  unstyled
                />
              </div>
            </div>

            {/* Model list */}
            <div className="relative min-h-0 flex-1 overflow-hidden">
              <ComboboxListVirtualized className="h-full space-y-0.5 overflow-y-auto overscroll-contain p-0 not-empty:px-2 not-empty:py-1.5">
                {visibleModels.map((model, index) => (
                  <VoiceModelRow
                    key={model.id}
                    index={index}
                    model={model}
                    group={groupByKey.get(providerKeyForModelId(model.id))!}
                  />
                ))}
              </ComboboxListVirtualized>
            </div>
            <ComboboxEmpty className="not-empty:py-6 empty:h-0 text-xs font-normal leading-snug">
              No models found
            </ComboboxEmpty>

            {/* Custom model escape hatch */}
            <div className="border-t border-border/70 p-1.5">
              <button
                type="button"
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition-colors hover:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))]",
                  props.isCustom && "bg-foreground/[0.08]",
                )}
                onClick={() => {
                  props.onSelectCustom();
                  props.onRequestClose();
                }}
              >
                <PencilIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                Custom model ID…
              </button>
            </div>
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
}

export const VoiceModelPicker = memo(function VoiceModelPicker(props: {
  models: ReadonlyArray<OpenRouterModelOption>;
  /** Current model id from voice settings (may be a custom id not in `models`). */
  value: string;
  /** Whether the settings row is in custom-model-ID mode. */
  isCustom: boolean;
  disabled?: boolean;
  onSelect: (modelId: string) => void;
  onSelectCustom: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const selectedModel = props.models.find((model) => model.id === props.value) ?? null;
  const triggerGroup: VoiceProviderGroup | null = selectedModel
    ? {
        key: providerKeyForModelId(selectedModel.id),
        displayName:
          VOICE_PROVIDER_NAME_BY_AUTHOR[providerKeyForModelId(selectedModel.id)] ??
          selectedModel.providerName,
        models: [],
      }
    : null;
  const triggerLabel = props.isCustom
    ? props.value || "Custom model ID…"
    : selectedModel
      ? stripProviderPrefix(selectedModel.name)
      : props.value || "Select a model";

  return (
    <Popover open={isOpen} onOpenChange={(open) => setIsOpen(props.disabled ? false : open)}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Voice model"
            disabled={props.disabled}
            className="flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-border bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          />
        }
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {triggerGroup ? <VoiceProviderGlyph group={triggerGroup} className="size-4" /> : null}
          <span className="min-w-0 flex-1 truncate text-left">{triggerLabel}</span>
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="border-0 bg-transparent p-0 shadow-none before:hidden [-webkit-backdrop-filter:none]! [--viewport-inline-padding:0] [backdrop-filter:none]!"
        viewportClassName="rounded-lg !overflow-hidden p-0"
      >
        <VoiceModelPickerContent
          models={props.models}
          value={props.value}
          isCustom={props.isCustom}
          onSelect={(modelId) => {
            props.onSelect(modelId);
            setIsOpen(false);
          }}
          onSelectCustom={props.onSelectCustom}
          onRequestClose={() => setIsOpen(false)}
        />
      </PopoverPopup>
    </Popover>
  );
});
