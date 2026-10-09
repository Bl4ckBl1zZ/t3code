import { RefreshIcon } from "~/components/ui/refresh-icon";
import { UsageLimits } from "./UsageLimits";
import { UsageEnvironmentFilter } from "./UsageEnvironmentFilter";
import { UsageProviderFilter } from "./UsageProviderFilter";
import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
  type UsagePagePreferences,
} from "./usagePagePreferences";
import type { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { isUsageUpdating } from "@t3tools/client-runtime/state/usage-progress";
import { InfoIcon } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import {
  isModelCostUnknown,
  type DailyTotals,
  type HourlyTotals,
} from "@t3tools/shared/usageMerge";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useUsage } from "../../state/usage";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { Button, InlineButton } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { UsagePriceOverrides } from "./UsagePriceOverrides";
import { UsageProviderChart, type UsageChartMetric } from "./UsageProviderChart";
import { SpeedPremium, UsageModelDialog } from "./UsageModelDialog";
import { UsageShareBar } from "./UsageShareBar";
import {
  costTypeSegments,
  modelShare,
  sortModelsByTokens,
  speedCostSegments,
  tokenTypeSegments,
} from "./usageBreakdown";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION, providersWithUsage } from "./usageProviders";
import { METRIC_OPTIONS, WINDOW_OPTIONS, resolveUsageShortcut } from "./usageShortcuts";

// Limits is its own view here, reached from a button rather than the metric toggle.
const [COST_OPTION, TOKENS_OPTION, LIMITS_OPTION] = METRIC_OPTIONS;
const CHART_METRIC_OPTIONS = [COST_OPTION, TOKENS_OPTION];

type UsageShortcutOption = (typeof METRIC_OPTIONS)[number] | (typeof WINDOW_OPTIONS)[number];

export function UsagePage() {
  const [preferences, setPreferences] = useState(readUsagePagePreferences);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const updatePreferences = (next: UsagePagePreferences) => {
    setPreferences(next);
    saveUsagePagePreferences(next);
  };
  const hiddenProviders = useMemo(
    () => new Set(preferences.hiddenProviders),
    [preferences.hiddenProviders],
  );
  const providerFilter = (
    <UsageProviderFilter
      hiddenProviders={hiddenProviders}
      onChange={(next) => updatePreferences({ ...preferences, hiddenProviders: next })}
    />
  );
  useEscapeToGoBack();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const onUsageKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      isCommandPaletteOpen() ||
      isModelPickerOpen()
    )
      return;

    const command = resolveUsageShortcut(event, keybindings);
    const metricOption = METRIC_OPTIONS.find((option) => option.command === command);
    const periodOption = WINDOW_OPTIONS.find((option) => option.command === command);
    if (!metricOption && !periodOption) return;

    event.preventDefault();
    event.stopPropagation();
    if (metricOption) updatePreferences({ ...preferences, metric: metricOption.value });
    // Limits has no time range, so period shortcuts do nothing there.
    if (periodOption && preferences.metric !== "limits") {
      updatePreferences({ ...preferences, windowDays: periodOption.days });
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", onUsageKeyDown, true);
    return () => window.removeEventListener("keydown", onUsageKeyDown, true);
  }, []);

  return preferences.metric === "limits" ? (
    <UsageLimits
      selected={selectedEnvironmentIds}
      setSelected={setSelectedEnvironmentIds}
      hiddenProviders={hiddenProviders}
      providerFilter={providerFilter}
      onShowUsage={() => updatePreferences({ ...preferences, metric: "cost" })}
    />
  ) : (
    <UsageHistoryPage
      preferences={preferences}
      updatePreferences={updatePreferences}
      selectedEnvironmentIds={selectedEnvironmentIds}
      setSelectedEnvironmentIds={setSelectedEnvironmentIds}
      hiddenProviders={hiddenProviders}
      providerFilter={providerFilter}
      onShowLimits={() => updatePreferences({ ...preferences, metric: "limits" })}
    />
  );
}

function UsageHistoryPage({
  onShowLimits,
  preferences,
  updatePreferences,
  selectedEnvironmentIds,
  setSelectedEnvironmentIds,
  hiddenProviders,
  providerFilter,
}: {
  onShowLimits: () => void;
  preferences: UsagePagePreferences;
  updatePreferences: (next: UsagePagePreferences) => void;
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  setSelectedEnvironmentIds: (next: ReadonlySet<EnvironmentId> | null) => void;
  hiddenProviders: ReadonlySet<UsageProviderKind>;
  providerFilter: ReactNode;
}) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcutTitle = (option: UsageShortcutOption) => {
    const shortcut = shortcutLabelForCommand(keybindings, option.command, {
      context: { usagePageOpen: true },
    });
    return shortcut ? `${option.label} (${shortcut})` : option.label;
  };
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: preferences.windowDays,
    window: makeWindow(
      preferences.windowDays,
      undefined,
      preferences.windowDays === 1 ? "hour" : "day",
    ),
  }));
  // The saved period is the source of truth: toggles and page shortcuts both
  // change it, and the window is rebuilt from the current time when it moves.
  if (windowSelection.days !== preferences.windowDays) {
    setWindowSelection({
      days: preferences.windowDays,
      window: makeWindow(
        preferences.windowDays,
        undefined,
        preferences.windowDays === 1 ? "hour" : "day",
      ),
    });
  }
  const metric = preferences.metric === "tokens" ? "tokens" : "cost";
  const setMetric = (metric: UsageChartMetric) => updatePreferences({ ...preferences, metric });
  const [breakdown, setBreakdown] = useState<"model" | "time">("model");
  const [priceDialog, setPriceDialog] = useState<{ readonly model?: string } | null>(null);
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const {
    merged: answeredUsage,
    environments,
    selectedEnvironments,
    shown,
    isPartial,
    refresh,
  } = useUsage(window, selectedEnvironmentIds, hiddenProviders);
  // Until a new window's first answer, the previous one stays on screen, muted.
  const merged = shown?.merged ?? answeredUsage;
  const shownWindow = shown?.window ?? window;
  const shownHourly = shownWindow.resolution === "hour";
  // Usage kept from another window is all old, so every figure stays muted.
  const showingKept = shown !== null && shown.window !== window;
  const loading = showingKept || isUsageUpdating(selectedEnvironments, isRefreshing);

  const days = useMemo(
    () => enumerateDays(shownWindow.sinceDay, shownWindow.untilDay),
    [shownWindow.sinceDay, shownWindow.untilDay],
  );
  const hours = useMemo(
    () =>
      shownWindow.sinceTime === undefined || shownWindow.untilTime === undefined
        ? []
        : enumerateHourStarts(shownWindow.sinceTime, shownWindow.untilTime),
    [shownWindow.sinceTime, shownWindow.untilTime],
  );
  // Newest first: the window can run 90 periods, so the interesting end
  // belongs at the top of the table.
  const breakdownPeriods = useMemo<readonly (DailyTotals | HourlyTotals)[]>(
    () => (shownHourly ? merged.hourly : merged.daily).toReversed(),
    [shownHourly, merged.daily, merged.hourly],
  );
  const breakdownModels = useMemo(
    () =>
      breakdown === "model" && metric === "tokens"
        ? sortModelsByTokens(merged.models)
        : merged.models,
    [breakdown, merged.models, metric],
  );
  const activeProviders = useMemo(() => providersWithUsage(merged.providers), [merged.providers]);
  const chartLoadingProviders = useMemo(
    () => new Set(loading ? activeProviders : []),
    [activeProviders, loading],
  );
  const selectedModel =
    selectedModelKey === null
      ? undefined
      : merged.models.find((model) => `${model.provider}:${model.model}` === selectedModelKey);
  const breakdownPeak = breakdownModels.reduce(
    (peak, model) => Math.max(peak, metric === "tokens" ? model.totalTokens : model.costUsd),
    0,
  );
  const timeValueColumnWidth = `${60 / (activeProviders.length + 2)}%`;

  const selectWindow = (days: number) => {
    if (days !== 1 && days !== 7 && days !== 30 && days !== 90) return;
    updatePreferences({ ...preferences, windowDays: days });
  };
  const refreshWindow = () => {
    if (refreshingRef.current) return;
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    if (
      nextWindow.sinceDay !== window.sinceDay ||
      nextWindow.untilDay !== window.untilDay ||
      nextWindow.sinceTime !== window.sinceTime ||
      nextWindow.untilTime !== window.untilTime
    ) {
      setWindowSelection({ days: windowDays, window: nextWindow });
    }
    refreshingRef.current = true;
    setIsRefreshing(true);
    void refresh(nextWindow).finally(() => {
      refreshingRef.current = false;
      setIsRefreshing(false);
    });
  };
  // Names the period on screen, which is the previous one until the new one answers.
  const windowLabel =
    shownHourly && shownWindow.sinceTime !== undefined && shownWindow.untilTime !== undefined
      ? `${formatDateTimeShort(shownWindow.sinceTime, shownWindow.timeZone)} to ${formatDateTimeShort(shownWindow.untilTime, shownWindow.timeZone)}`
      : `${formatDayShort(shownWindow.sinceDay)} to ${formatDayShort(shownWindow.untilDay)}`;
  const topbarContent = (
    <div className="flex w-full min-w-0 items-center gap-3">
      <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb" className="min-w-0">
        <WorkspaceBreadcrumbItem current>
          <h1>Usage</h1>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator className="hidden md:flex" />
        <WorkspaceBreadcrumbItem className="hidden min-w-0 shrink md:flex">
          <span className="truncate">{windowLabel}</span>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <div className="ms-auto hidden min-w-0 items-center justify-end gap-2 lg:flex">
        <ToggleGroup
          aria-label="Usage metric"
          variant="segmented"
          value={[metric]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "cost" || value === "tokens") setMetric(value);
          }}
        >
          {CHART_METRIC_OPTIONS.map((option) => (
            <Toggle key={option.value} value={option.value} title={shortcutTitle(option)}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
        <ToggleGroup
          aria-label="Usage period"
          variant="segmented"
          value={[String(windowDays)]}
          onValueChange={(next) => {
            const value = next[0];
            if (value) selectWindow(Number(value));
          }}
        >
          {WINDOW_OPTIONS.map((option) => (
            <Toggle key={option.days} value={String(option.days)} title={shortcutTitle(option)}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
        <Button
          size="sm"
          variant="ghost"
          onClick={onShowLimits}
          title={shortcutTitle(LIMITS_OPTION)}
        >
          {LIMITS_OPTION.label}
        </Button>
        <Button
          disabled={isRefreshing}
          aria-busy={isRefreshing}
          onClick={refreshWindow}
          aria-label="Refresh usage"
          size="icon-sm"
          variant="ghost"
        >
          <RefreshIcon size="sm" refreshing={isRefreshing} />
        </Button>
      </div>
      <div className="ms-auto flex min-w-0 items-center justify-end gap-1 lg:hidden">
        <Select
          value={metric}
          onValueChange={(value) => {
            if (value === "cost" || value === "tokens") setMetric(value);
          }}
        >
          <SelectTrigger
            aria-label="Usage metric"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>{metric === "cost" ? "Cost" : "Tokens"}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {CHART_METRIC_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} title={shortcutTitle(option)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select value={String(windowDays)} onValueChange={(value) => selectWindow(Number(value))}>
          <SelectTrigger
            aria-label="Usage period"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>
              {WINDOW_OPTIONS.find((option) => option.days === windowDays)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {WINDOW_OPTIONS.map((option) => (
              <SelectItem
                key={option.days}
                value={String(option.days)}
                title={shortcutTitle(option)}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          size="sm"
          variant="ghost"
          onClick={onShowLimits}
          title={shortcutTitle(LIMITS_OPTION)}
        >
          {LIMITS_OPTION.label}
        </Button>
        <Button
          disabled={isRefreshing}
          aria-busy={isRefreshing}
          onClick={refreshWindow}
          aria-label="Refresh usage"
          size="icon-sm"
          variant="ghost"
        >
          <RefreshIcon size="sm" refreshing={isRefreshing} />
        </Button>
      </div>
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>{topbarContent}</WorkspacePageHeader>

        <div className="flex min-w-0 items-center gap-1 border-b border-border px-4 py-2 text-sm">
          <UsageEnvironmentFilter
            environments={environments}
            selectedEnvironments={selectedEnvironments}
            selectedEnvironmentIds={selectedEnvironmentIds}
            onSelectionChange={setSelectedEnvironmentIds}
            showUsageStatus
            refreshing={isRefreshing}
            isPartial={isPartial}
            duplicateSources={merged.duplicateSources}
            contractMismatches={merged.contractMismatches}
            onOpenModelPrices={() => setPriceDialog({})}
          />
          <span aria-hidden className="text-muted-foreground/60">
            ·
          </span>
          {providerFilter}
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {selectedEnvironments.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {environments.length === 0
                  ? "Connect an environment to see usage."
                  : "Select an environment to see usage."}
              </p>
            ) : shown === null ? (
              <UsageSkeleton />
            ) : (
              <div aria-busy={loading} className="flex flex-col gap-6">
                <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
                  <div className="flex min-w-0 flex-col gap-5">
                    <div className="flex flex-col gap-1">
                      <span
                        className={cn(
                          "text-4xl font-semibold text-foreground tabular-nums",
                          figureClass(loading),
                        )}
                      >
                        {metric === "cost"
                          ? formatUsd(merged.costUsd)
                          : formatTokens(merged.totalTokens)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        <span className={figureClass(loading)}>
                          {formatCount(merged.sessions)} sessions
                        </span>
                        {metric === "cost" && (
                          <>
                            {" · API estimate"}
                            {merged.costQuality.unpricedShare > 0 && (
                              <>
                                {" "}
                                <Popover>
                                  <PopoverTrigger
                                    openOnHover
                                    render={<InlineButton tone="muted" />}
                                    aria-label="Unpriced usage details"
                                  >
                                    <InfoIcon className="size-3" aria-hidden />
                                  </PopoverTrigger>
                                  <PopoverPopup side="top" tooltipStyle>
                                    API estimate excludes{" "}
                                    {formatPercent(merged.costQuality.unpricedShare)} unpriced
                                    records.
                                  </PopoverPopup>
                                </Popover>
                              </>
                            )}
                          </>
                        )}
                      </span>
                    </div>

                    {activeProviders.map((provider) => {
                      const totals = merged.providers.find((entry) => entry.provider === provider);
                      const share =
                        metric === "cost" ? (totals?.costShare ?? 0) : (totals?.tokenShare ?? 0);
                      const providerSessions = totals?.sessions ?? 0;
                      const sessionLabel = `${formatCount(providerSessions)} ${
                        providerSessions === 1 ? "session" : "sessions"
                      }`;
                      return (
                        <div key={provider} className="flex flex-col gap-1">
                          <div className="flex items-baseline justify-between gap-4">
                            <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                              <span
                                aria-hidden
                                className="size-2 shrink-0 rounded-full"
                                style={{
                                  backgroundColor: PROVIDER_PRESENTATION[provider].color,
                                }}
                              />
                              <ProviderMark provider={provider} className="size-4" />
                              <span className="flex min-w-0 items-baseline gap-1.5">
                                <span className="truncate">
                                  {PROVIDER_PRESENTATION[provider].label}
                                </span>
                                <span
                                  className={cn(
                                    "shrink-0 whitespace-nowrap text-2xs text-muted-foreground tabular-nums",
                                    figureClass(loading),
                                  )}
                                >
                                  {sessionLabel}
                                </span>
                              </span>
                            </span>
                            <span
                              className={cn(
                                "shrink-0 text-sm font-medium text-foreground tabular-nums",
                                figureClass(loading),
                              )}
                            >
                              {metric === "cost"
                                ? formatUsd(totals?.costUsd ?? 0)
                                : formatTokens(totals?.totalTokens ?? 0)}
                            </span>
                          </div>
                          <span
                            className={cn("text-xs text-muted-foreground", figureClass(loading))}
                          >
                            {metric === "cost"
                              ? `${formatPercent(share)} of cost · ${formatTokens(totals?.totalTokens ?? 0)} tokens`
                              : `${formatPercent(share)} of tokens · ${formatUsd(totals?.costUsd ?? 0)}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex min-w-0 flex-col gap-3">
                    <h2 className="text-sm font-medium text-foreground">
                      {shownHourly ? "Hourly" : "Daily"}{" "}
                      {metric === "tokens" ? "processed tokens" : "cost"}
                    </h2>
                    <UsageProviderChart
                      providers={activeProviders}
                      loadingProviders={chartLoadingProviders}
                      days={days}
                      daily={merged.daily}
                      hours={hours}
                      hourly={merged.hourly}
                      metric={metric}
                      referenceTime={shownWindow.untilTime}
                      resolution={shownHourly ? "hour" : "day"}
                      timeZone={shownWindow.timeZone}
                    />
                  </div>
                </section>

                <section className="flex flex-col gap-2">
                  <h2 className="text-sm font-medium text-foreground">Totals</h2>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
                    <Metric
                      loading={loading}
                      label="Processed tokens"
                      value={formatTokens(merged.totalTokens)}
                    />
                    <Metric
                      loading={loading}
                      label="Cached input"
                      value={formatTokens(merged.cachedInputTokens)}
                    />
                    <Metric
                      loading={loading}
                      label="Uncached input"
                      value={formatTokens(merged.uncachedInputTokens)}
                    />
                    <Metric
                      loading={loading}
                      label="Output"
                      value={formatTokens(merged.outputTokens)}
                    />
                    <Metric
                      loading={loading}
                      label="Cache savings"
                      value={formatUsd(merged.costQuality.cacheSavingsUsd)}
                    />
                  </div>
                </section>

                {merged.totalTokens > 0 ? (
                  <section
                    className={cn("grid gap-x-12 gap-y-8 lg:grid-cols-2", figureClass(loading))}
                  >
                    {metric === "tokens" ? (
                      <UsageShareBar
                        label="Tokens by type"
                        segments={tokenTypeSegments(merged)}
                        format={formatTokens}
                      />
                    ) : (
                      <>
                        <UsageShareBar
                          label="Cost by type"
                          segments={costTypeSegments(merged.categoryCost)}
                          format={formatUsd}
                        />
                        {merged.speedCost.fast + merged.speedCost.ultrafast > 0 ? (
                          <UsageShareBar
                            label="Cost by speed"
                            segments={speedCostSegments(merged.speedCost)}
                            format={formatUsd}
                            aside={<SpeedPremium premiumUsd={merged.speedCost.premium} />}
                          />
                        ) : null}
                      </>
                    )}
                  </section>
                ) : null}

                <section className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
                    <ToggleGroup
                      aria-label="Usage breakdown"
                      variant="segmented"
                      value={[breakdown]}
                      onValueChange={(next) => {
                        const value = next[0];
                        if (value === "model" || value === "time") setBreakdown(value);
                      }}
                    >
                      {(
                        [
                          { value: "model", label: "Model" },
                          { value: "time", label: shownHourly ? "Hour" : "Day" },
                        ] as const
                      ).map((option) => (
                        <Toggle key={option.value} value={option.value}>
                          {option.label}
                        </Toggle>
                      ))}
                    </ToggleGroup>
                  </div>

                  {breakdown === "model" ? (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-right text-xs text-muted-foreground">
                          <th className="py-2 pr-3 text-left font-normal">#</th>
                          <th className="w-full py-2 text-left font-normal">Model</th>
                          <th className="py-2 pl-6 font-normal">Cost</th>
                          <th className="hidden py-2 pl-6 font-normal sm:table-cell">Share</th>
                          <th className="py-2 pl-6 font-normal">Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdownModels.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="py-6 text-center text-muted-foreground">
                              No activity in this window.
                            </td>
                          </tr>
                        ) : (
                          breakdownModels.map((model, index) => {
                            const key = `${model.provider}:${model.model}`;
                            const value = metric === "tokens" ? model.totalTokens : model.costUsd;
                            const share = modelShare(
                              model,
                              metric === "tokens" ? "tokens" : "cost",
                            );
                            return (
                              <tr
                                key={key}
                                className="relative border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors hover:bg-muted/50 has-focus-visible:bg-muted/50"
                              >
                                <td className="py-2.5 pr-3 text-left text-xs">{index + 1}</td>
                                <td className="py-2.5 text-left whitespace-normal">
                                  {/* The button's overlay makes the whole row open the model.
                                      Focus shows as the row's hover fill, not a ring. */}
                                  <button
                                    type="button"
                                    onClick={() => setSelectedModelKey(key)}
                                    className="flex items-center gap-2 text-left text-foreground outline-none after:absolute after:inset-0"
                                  >
                                    <ProviderMark provider={model.provider} className="size-3.5" />
                                    {model.model}
                                  </button>
                                  <div
                                    aria-hidden
                                    className={cn("mt-1.5 h-0.5 max-w-48", figureClass(loading))}
                                  >
                                    <div
                                      className="h-full rounded-full"
                                      style={{
                                        // A short minimum keeps tiny shares a dash, not a dot.
                                        width:
                                          value > 0 && breakdownPeak > 0
                                            ? `max(0.5rem, ${(value / breakdownPeak) * 100}%)`
                                            : 0,
                                        backgroundColor:
                                          PROVIDER_PRESENTATION[model.provider].color,
                                      }}
                                    />
                                  </div>
                                </td>
                                <td
                                  className={cn(
                                    "py-2.5 pl-6 text-foreground",
                                    figureClass(loading),
                                  )}
                                >
                                  {isModelCostUnknown(model) ? (
                                    <span className="text-muted-foreground">Unpriced</span>
                                  ) : (
                                    formatUsd(model.costUsd)
                                  )}
                                </td>
                                <td
                                  className={cn(
                                    "hidden py-2.5 pl-6 sm:table-cell",
                                    figureClass(loading),
                                  )}
                                >
                                  {share === null ? "" : formatPercent(share)}
                                </td>
                                <td className={cn("py-2.5 pl-6", figureClass(loading))}>
                                  {formatTokens(model.totalTokens)}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  ) : (
                    <table className="w-full table-fixed text-sm">
                      <colgroup>
                        <col className="w-2/5" />
                        {activeProviders.map((provider) => (
                          <col key={provider} style={{ width: timeValueColumnWidth }} />
                        ))}
                        <col style={{ width: timeValueColumnWidth }} />
                        <col style={{ width: timeValueColumnWidth }} />
                      </colgroup>
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="py-2 font-normal">{shownHourly ? "Hour" : "Day"}</th>
                          {activeProviders.map((provider) => (
                            <th key={provider} className="py-2 text-right font-normal">
                              {PROVIDER_PRESENTATION[provider].label}
                            </th>
                          ))}
                          <th className="py-2 text-right font-normal">Total</th>
                          <th className="py-2 text-right font-normal">Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdownPeriods.length === 0 ? (
                          <tr>
                            <td
                              colSpan={activeProviders.length + 3}
                              className="py-6 text-center text-muted-foreground"
                            >
                              No activity in this window.
                            </td>
                          </tr>
                        ) : (
                          breakdownPeriods.map((period) => (
                            <tr
                              key={"hourStart" in period ? period.hourStart : period.day}
                              className="border-b border-border/50 transition-colors hover:bg-muted/50"
                            >
                              <td className="py-2 text-foreground">
                                {"hourStart" in period
                                  ? formatHourShort(period.hourStart, shownWindow.timeZone)
                                  : formatDayShort(period.day)}
                              </td>
                              {activeProviders.map((provider) => (
                                <td
                                  key={provider}
                                  className={cn(
                                    "py-2 text-right text-muted-foreground tabular-nums",
                                    figureClass(loading),
                                  )}
                                >
                                  {formatUsd(period.byProvider.get(provider)?.costUsd ?? 0)}
                                </td>
                              ))}
                              <td
                                className={cn(
                                  "py-2 text-right text-foreground tabular-nums",
                                  figureClass(loading),
                                )}
                              >
                                {formatUsd(period.costUsd)}
                              </td>
                              <td
                                className={cn(
                                  "py-2 text-right text-muted-foreground tabular-nums",
                                  figureClass(loading),
                                )}
                              >
                                {formatTokens(period.totalTokens)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  )}
                </section>
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {selectedModel !== undefined ? (
        <UsageModelDialog
          model={selectedModel}
          environments={selectedEnvironments}
          metric={metric}
          chartWindow={{
            days,
            hours,
            resolution: shownHourly ? "hour" : "day",
            timeZone: shownWindow.timeZone,
            referenceTime: shownWindow.untilTime,
          }}
          onSetPrice={() => {
            setSelectedModelKey(null);
            setPriceDialog({ model: selectedModel.model });
          }}
          onClose={() => setSelectedModelKey(null)}
        />
      ) : null}
      {priceDialog ? (
        <UsagePriceOverrides
          usage={environments}
          initialSelectedEnvironmentIds={selectedEnvironmentIds}
          initialModel={priceDialog.model}
          onOpenChange={(open) => {
            if (!open) setPriceDialog(null);
          }}
        />
      ) : null}
    </SidebarInset>
  );
}

/** Brand mark for the harness a row belongs to. */
function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const Mark = PROVIDER_PRESENTATION[provider].mark;
  return <Mark className={cn("shrink-0", className)} aria-hidden />;
}

/** Mutes a figure that is still coming in. The delay keeps a quick answer from flashing. */
function figureClass(loading: boolean) {
  return cn("transition-opacity", loading && "opacity-40 delay-150");
}

function Metric({
  label,
  value,
  loading,
}: {
  readonly label: string;
  readonly value: string;
  readonly loading: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn("text-base font-medium text-foreground tabular-nums", figureClass(loading))}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Stand-in with the loaded page's shape, using the shared `Skeleton` bars so it
 * breathes with the same `animate-skeleton` pulse as every other loading state.
 * Blocks fill in exactly once when the last device answers.
 */
function UsageSkeleton() {
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <Skeleton className="h-10 w-36" />
            <Skeleton className="h-4 w-32" />
          </div>
          {PROVIDER_ORDER.map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <Skeleton shape="pill" className="size-2 shrink-0" />
                  <Skeleton shape="pill" className="size-4 shrink-0" />
                  <Skeleton className="h-3.5 w-20" />
                </span>
                <Skeleton className="h-3.5 w-14" />
              </div>
              <Skeleton className="h-4 w-36" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-24" />
          <div className="flex flex-col gap-1">
            <Skeleton className="ml-16 h-56" />
            <Skeleton className="ml-16 h-4" />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">Totals</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
          {["Processed tokens", "Cached input", "Uncached input", "Output", "Cache savings"].map(
            (label) => (
              <div key={label} className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">{label}</span>
                <Skeleton className="h-6 w-16" />
              </div>
            ),
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
          <Skeleton shape="card" className="h-7 w-28" />
        </div>
        <Skeleton className="h-44" />
      </section>
    </>
  );
}
