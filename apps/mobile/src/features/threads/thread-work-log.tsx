import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { dynamicToolInputPreview } from "@t3tools/shared/dynamicToolPreview";
import { useNavigation } from "@react-navigation/native";
import { LayoutAnimation, Pressable, useColorScheme, View } from "react-native";

import {
  changedFileName,
  selectChangedFilePreview,
  summarizeChangedFileScopes,
} from "@t3tools/shared/changedFilesPreview";
import { deriveThreadCheckpointSummaries } from "@t3tools/client-runtime/state/thread-checkpoints";

import { AppText as Text } from "../../components/AppText";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { ShimmerText } from "../../components/ShimmerText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useThreadProjection } from "../../state/use-thread-detail";
import { getReviewSectionIdForCheckpoint } from "../review/reviewModel";
import { setReviewSelectedFilePath, setReviewSelectedSectionId } from "../review/reviewState";
import { T3_CODE_BRAND_MARK_SOURCE } from "../../components/brandAssets";
import { scaledTypographyLineHeight } from "../../lib/appearancePreferences";
import { cn } from "../../lib/cn";
import { resolveWorkspaceRelativeFilePath } from "../files/filePath";
import {
  activityFileDiffStats,
  sumActivityFileDiffStats,
  type ThreadFeedActivity,
} from "../../lib/threadActivity";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import Animated, { FadeIn } from "react-native-reanimated";
import { ThreadActivityInspector } from "./ThreadActivityInspector";
import { threadWorkLogOverflowNoun } from "./thread-work-log-labels";

const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;
const WORK_LOG_LAYOUT_ANIMATION = {
  duration: 180,
  create: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
  update: { type: LayoutAnimation.Types.easeInEaseOut },
  delete: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
} as const;

function triggerDisclosureFeedback() {
  LayoutAnimation.configureNext(WORK_LOG_LAYOUT_ANIMATION);
  void Haptics.selectionAsync();
}

// Rows whose underlying turn item is still in flight shimmer their text.
const IN_PROGRESS_ITEM_STATUSES = new Set(["pending", "running", "waiting"]);

function stripShellWrapper(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^\/bin\/zsh -lc ['"]?([\s\S]*?)['"]?$/);
  return (match?.[1] ?? trimmed).trim();
}

function compactActivityDetail(detail: string | null): string | null {
  if (!detail) {
    return null;
  }

  const cleaned = stripShellWrapper(detail).replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function workRowSymbolName(icon: ThreadFeedActivity["icon"]): AppSymbolName {
  switch (icon) {
    case "agent":
      return { ios: "sparkles", android: "auto_awesome" };
    case "alert":
      return { ios: "exclamationmark.triangle", android: "error" };
    case "check":
      return { ios: "checkmark", android: "check" };
    case "command":
      return { ios: "terminal", android: "terminal" };
    case "edit":
      return { ios: "square.and.pencil", android: "edit" };
    case "eye":
      return { ios: "eye", android: "visibility" };
    case "globe":
      return { ios: "globe", android: "public" };
    case "hammer":
      return { ios: "hammer", android: "construction" };
    case "message":
      return { ios: "bubble.left", android: "chat_bubble" };
    case "warning":
      return { ios: "xmark", android: "close" };
    case "wrench":
      return { ios: "wrench", android: "build" };
    case "zap":
      return { ios: "bolt", android: "bolt" };
  }
}

// Path presentation for file rows: trailing directories stay muted while the
// filename carries full foreground weight, mirroring the web timeline.
function splitDisplayPath(
  path: string,
  workspaceRoot: string | null | undefined,
): { readonly prefix: string; readonly name: string } {
  const relative = resolveWorkspaceRelativeFilePath(workspaceRoot, path) ?? path;
  const segments = relative.replaceAll("\\", "/").split("/").filter(Boolean);
  const name = segments.at(-1) ?? relative;
  const dirSegments = segments.slice(0, -1);
  const shownDirs = dirSegments.slice(-2);
  const prefix =
    shownDirs.length === 0
      ? ""
      : `${dirSegments.length > shownDirs.length ? "…/" : ""}${shownDirs.join("/")}/`;
  return { prefix, name };
}

function WorkRowDiffStat(props: { readonly additions: number; readonly deletions: number }) {
  if (props.additions <= 0 && props.deletions <= 0) {
    return null;
  }
  return (
    <View className="shrink-0 flex-row items-center gap-1 pl-1">
      {props.additions > 0 ? (
        <Text className="font-mono text-2xs text-emerald-600 dark:text-emerald-400">
          +{props.additions}
        </Text>
      ) : null}
      {props.deletions > 0 ? (
        <Text className="font-mono text-2xs text-rose-600 dark:text-rose-400">
          −{props.deletions}
        </Text>
      ) : null}
    </View>
  );
}

// Checkpoint rows render as a "changed files" summary card: a header with the
// file count, total diffstat, and an Open diff shortcut into the review
// screen. Collapsed, it previews the touched scopes and a few file chips
// (compact form of the web timeline card); expanded, one row per file.
function ChangedFilesSummaryCard(props: {
  readonly checkpointId: string;
  readonly environmentId: EnvironmentId;
  readonly expanded: boolean;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly onToggle: () => void;
  readonly pressedBackground: string;
  readonly threadId: ThreadId;
  readonly workspaceRoot?: string | null;
}) {
  const navigation = useNavigation();
  const thread = useThreadProjection({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const totalAdditions = props.files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = props.files.reduce((sum, file) => sum + file.deletions, 0);
  const scopeSummary = summarizeChangedFileScopes(props.files);
  const previewFiles = selectChangedFilePreview(props.files);

  // "Open diff" = the mobile review screen, pre-selected to this checkpoint's
  // turn section (and file, when a chip was tapped). A checkpoint that hasn't
  // reached "ready" has no section yet — the review screen falls back to its
  // default selection.
  const openDiff = (filePath: string | null) => {
    void Haptics.selectionAsync();
    const threadKey = scopedThreadKey(props.environmentId, props.threadId);
    const checkpoint =
      thread === null
        ? undefined
        : deriveThreadCheckpointSummaries(thread.projection).find(
            (summary) => summary.checkpointId === props.checkpointId,
          );
    if (checkpoint !== undefined) {
      setReviewSelectedSectionId(threadKey, getReviewSectionIdForCheckpoint(checkpoint));
    }
    setReviewSelectedFilePath(threadKey, filePath);
    navigation.navigate("ThreadReview", {
      environmentId: props.environmentId,
      threadId: props.threadId,
    });
  };

  return (
    <View className="mb-2 overflow-hidden rounded-xl border border-neutral-300/60 bg-card dark:border-white/[0.1]">
      <View className="flex-row items-center">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: props.expanded }}
          accessibilityLabel={`${props.files.length} changed ${props.files.length === 1 ? "file" : "files"}`}
          accessibilityHint={
            props.expanded ? "Double tap to hide files." : "Double tap to show files."
          }
          hitSlop={4}
          onPress={() => {
            triggerDisclosureFeedback();
            props.onToggle();
          }}
          style={({ pressed }) => ({
            backgroundColor: pressed ? props.pressedBackground : "transparent",
          })}
          className="min-h-9 min-w-0 flex-1 flex-row items-center gap-1.5 px-2 py-1"
        >
          <View className="h-4 w-4 items-center justify-center">
            <SymbolView
              name={
                props.expanded
                  ? { ios: "chevron.up", android: "keyboard_arrow_up" }
                  : { ios: "chevron.down", android: "keyboard_arrow_down" }
              }
              size={11}
              tintColor={props.iconSubtleColor}
              type="monochrome"
            />
          </View>
          <Text className="font-t3-medium text-xs text-foreground">
            {props.files.length} changed {props.files.length === 1 ? "file" : "files"}
          </Text>
          <WorkRowDiffStat additions={totalAdditions} deletions={totalDeletions} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open diff"
          hitSlop={4}
          onPress={() => openDiff(null)}
          style={({ pressed }) => ({
            backgroundColor: pressed ? props.pressedBackground : "transparent",
          })}
          className="mx-2 my-1 shrink-0 flex-row items-center gap-1 rounded-md border border-neutral-300/60 px-1.5 py-1 dark:border-white/[0.1]"
        >
          <SymbolView
            name={{ ios: "doc.text", android: "description" }}
            size={11}
            tintColor={props.iconSubtleColor}
            type="monochrome"
          />
          <Text className="font-t3-medium text-2xs text-foreground">Open diff</Text>
        </Pressable>
      </View>

      {!props.expanded ? (
        <View className="border-t border-neutral-300/60 px-2 pb-2 pt-1.5 dark:border-white/[0.08]">
          <View className="flex-row flex-wrap items-center gap-x-1.5 gap-y-0.5">
            {scopeSummary.map((scope, index) => (
              <View key={scope.label} className="flex-row items-center gap-1">
                {index > 0 ? (
                  <Text className="text-2xs text-foreground-muted opacity-60">·</Text>
                ) : null}
                <Text className="font-mono text-2xs text-foreground opacity-75">{scope.label}</Text>
                <Text className="text-2xs text-foreground-muted opacity-60">
                  {scope.fileCount} file{scope.fileCount === 1 ? "" : "s"}
                </Text>
              </View>
            ))}
          </View>
          <View className="mt-1.5 flex-row flex-wrap items-center gap-1.5">
            {previewFiles.map((file) => (
              <Pressable
                key={file.path}
                accessibilityRole="button"
                accessibilityLabel={`Open diff for ${changedFileName(file.path)}`}
                onPress={() => openDiff(file.path)}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? props.pressedBackground : "transparent",
                })}
                className="max-w-48 flex-row items-center gap-1 rounded-md border border-neutral-300/60 px-1.5 py-1 dark:border-white/[0.1]"
              >
                <PierreEntryIcon path={file.path} kind="file" size={12} />
                <Text className="shrink font-mono text-2xs text-foreground-muted" numberOfLines={1}>
                  {changedFileName(file.path)}
                </Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Show all ${props.files.length} files`}
              hitSlop={4}
              onPress={() => {
                triggerDisclosureFeedback();
                props.onToggle();
              }}
              style={({ pressed }) => ({
                backgroundColor: pressed ? props.pressedBackground : "transparent",
              })}
              className="rounded-md px-1.5 py-1"
            >
              <Text className="font-t3-medium text-2xs text-foreground-muted">
                Show all {props.files.length} files
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {props.expanded ? (
        <View className="border-t border-neutral-300/60 px-2 py-1 dark:border-white/[0.08]">
          {props.files.map((file) => {
            const displayPath = splitDisplayPath(file.path, props.workspaceRoot);
            return (
              <View key={file.path} className="min-h-8 flex-row items-center gap-1.5">
                <Text className="min-w-0 flex-1 font-mono text-xs" numberOfLines={1}>
                  <Text className="text-foreground-muted opacity-60">{displayPath.prefix}</Text>
                  <Text className="text-foreground">{displayPath.name}</Text>
                </Text>
                {file.kind !== "modified" ? (
                  <Text className="shrink-0 text-3xs uppercase text-foreground-muted opacity-60">
                    {file.kind}
                  </Text>
                ) : null}
                <WorkRowDiffStat additions={file.additions} deletions={file.deletions} />
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function WorkRowIcon(props: {
  readonly row: ThreadFeedActivity;
  readonly iconSubtleColor: import("react-native").ColorValue;
}) {
  const iconIsDestructive = props.row.icon === "alert" || props.row.icon === "warning";
  if (props.row.logo === "t3-code") {
    return (
      <Image
        source={T3_CODE_BRAND_MARK_SOURCE}
        accessibilityIgnoresInvertColors
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
        }}
      />
    );
  }

  return (
    <SymbolView
      name={workRowSymbolName(props.row.icon)}
      size={14}
      weight="medium"
      tintColor={iconIsDestructive ? "#e11d48" : props.iconSubtleColor}
      type="monochrome"
    />
  );
}

function ThreadActivityThreadLink(props: {
  readonly activity: ThreadFeedActivity;
  readonly environmentId: EnvironmentId;
  readonly iconColor: import("react-native").ColorValue;
}) {
  const row = props.activity.projectedItem;
  const navigation = useNavigation();
  const item = row.item;
  let targetThreadId: ThreadId | null = null;
  let label = "Open related thread";

  if (item.type === "thread_created") {
    targetThreadId = item.targetThreadId;
    label = "Open created thread";
  } else if (item.type === "fork") {
    targetThreadId =
      item.targetThreadId === row.sourceThreadId && item.source.type === "run"
        ? item.source.threadId
        : item.targetThreadId;
    label = targetThreadId === item.targetThreadId ? "Open forked thread" : "Open parent thread";
  }

  if (targetThreadId === null) return null;

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={() => {
        void Haptics.selectionAsync();
        navigation.navigate("Thread", {
          environmentId: props.environmentId,
          threadId: targetThreadId,
        });
      }}
      className="mx-2 mb-2 min-h-9 flex-row items-center justify-center gap-1.5 rounded-lg border border-neutral-300/50 px-2 dark:border-white/[0.08]"
    >
      <Text className="font-t3-medium text-2xs text-foreground">{label}</Text>
      <SymbolView name="arrow.right" size={11} tintColor={props.iconColor} type="monochrome" />
    </Pressable>
  );
}

// Entering fades only for rows created moments ago: rows remount whenever the
// list scrolls them back into view, and old rows must not replay an entrance.
const FRESH_ROW_WINDOW_MS = 3_000;
function isFreshRow(createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ROW_WINDOW_MS;
}

// Tool-like activities with a neutral status carry no signal worth a row.
export function visibleWorkLogActivities(
  activities: ReadonlyArray<ThreadFeedActivity>,
): ReadonlyArray<ThreadFeedActivity> {
  return activities.filter((activity) => !(activity.toolLike && activity.status === "neutral"));
}

// Pre-measurement heights for the feed's getFixedItemSize. Collapsed work-log
// rows are single-line (numberOfLines={1}) inside a min-height that stays
// taller than the text at every supported base font size (text-xs reaches
// 23px at the 22pt maximum, under the 32px min-h-8), so row height is
// deterministic. The "work log" label has no such clamp — its height follows
// the scaled text-2xs line height. Values mirror the classNames below — keep
// them in sync; a mismatch only costs a one-time correction on measure.
const WORK_ROW_HEIGHT = 32; // min-h-8
const WORK_ROW_GAP = 1; // gap-px
const WORK_LOG_HEADER_PADDING = 2; // pb-0.5 under the "work log" label
const WORK_LOG_BOTTOM_MARGIN = 4; // mb-1

export const WORK_GROUP_TOGGLE_HEIGHT = 36; // min-h-8 (32) + mb-1 (4)

export function collapsedWorkLogHeight(
  activities: ReadonlyArray<ThreadFeedActivity>,
  baseFontSize: number,
): number {
  const rows = visibleWorkLogActivities(activities);
  if (rows.length === 0) {
    return 0;
  }
  const onlyToolRows = rows.every((row) => row.toolLike);
  const headerHeight =
    scaledTypographyLineHeight(MOBILE_TYPOGRAPHY.caption, baseFontSize) + WORK_LOG_HEADER_PADDING;
  return (
    WORK_LOG_BOTTOM_MARGIN +
    (onlyToolRows ? 0 : headerHeight) +
    rows.length * WORK_ROW_HEIGHT +
    (rows.length - 1) * WORK_ROW_GAP
  );
}

export function ThreadWorkLog(props: {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly copiedRowId: string | null;
  readonly currentThreadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly expanded: boolean;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly onCopyRow: (rowId: string, value: string) => void;
  readonly onToggleGroup: () => void;
  readonly onToggleRow: (rowId: string) => void;
  readonly workspaceRoot?: string | null;
}) {
  const colorScheme = useColorScheme();
  const pressedBackground = colorScheme === "dark" ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.035)";
  const rows = visibleWorkLogActivities(props.activities).map((activity) => ({
    ...activity,
    detail: compactActivityDetail(activity.detail),
  }));

  if (rows.length === 0) {
    return null;
  }

  const hasOverflow = rows.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleRows =
    hasOverflow && !props.expanded ? rows.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES) : rows;
  const hiddenCount = rows.length - visibleRows.length;
  const hiddenStats = sumActivityFileDiffStats(rows.slice(0, hiddenCount));
  const onlyToolRows = rows.every((row) => row.toolLike);
  const overflowNoun = threadWorkLogOverflowNoun(onlyToolRows, hiddenCount);

  return (
    <View className="-mx-1 mb-3 px-1 py-0.5">
      {!onlyToolRows ? (
        <Text className="px-0.5 pb-0.5 font-t3-medium text-2xs text-foreground-muted opacity-60">
          work log
        </Text>
      ) : null}

      <View className="gap-px">
        {visibleRows.map((row) => {
          const expanded = props.expandedRows[row.id] ?? false;
          const canExpand = row.canExpand;
          const detail = compactActivityDetail(row.detail);
          const displayText = detail ? `${row.summary} ${detail}` : row.summary;
          const textIsDestructive = row.icon === "alert" || row.icon === "warning";
          const item = row.projectedItem.item;
          const dynamicToolPath =
            item.type === "dynamic_tool" ? dynamicToolInputPreview(item.input) : null;
          const filePath =
            item.type === "file_change"
              ? splitDisplayPath(item.fileName, props.workspaceRoot)
              : dynamicToolPath?.kind === "path"
                ? splitDisplayPath(dynamicToolPath.value, props.workspaceRoot)
                : null;
          const diffStats = activityFileDiffStats(row);
          // The icon already communicates the tool kind on these rows, so the
          // detail (command text, search pattern, path) is the whole row.
          const hideSummaryLabel =
            detail !== null && (item.type === "command_execution" || item.type === "file_search");
          const inProgress = IN_PROGRESS_ITEM_STATUSES.has(item.status);
          const RowText = inProgress ? ShimmerText : Text;

          if (item.type === "checkpoint" && item.files.length > 0) {
            return (
              <Animated.View
                key={row.id}
                {...(isFreshRow(row.createdAt) ? { entering: FadeIn.duration(200) } : {})}
              >
                <ChangedFilesSummaryCard
                  checkpointId={item.checkpointId}
                  environmentId={props.environmentId}
                  expanded={expanded}
                  files={item.files}
                  iconSubtleColor={props.iconSubtleColor}
                  onToggle={() => props.onToggleRow(row.id)}
                  pressedBackground={pressedBackground}
                  threadId={props.currentThreadId}
                  workspaceRoot={props.workspaceRoot}
                />
              </Animated.View>
            );
          }

          return (
            <Animated.View
              key={row.id}
              {...(isFreshRow(row.createdAt) ? { entering: FadeIn.duration(200) } : {})}
              className={cn(
                row.prominent &&
                  "mb-2 overflow-hidden rounded-xl border border-neutral-300/60 bg-card dark:border-white/[0.1]",
              )}
            >
              <Pressable
                accessibilityRole={canExpand ? "button" : undefined}
                accessibilityLabel={displayText}
                accessibilityHint={
                  canExpand
                    ? "Double tap to show full details. Long press to copy."
                    : "Long press to copy."
                }
                accessibilityState={canExpand ? { expanded } : undefined}
                hitSlop={4}
                onPress={() => {
                  if (canExpand) {
                    triggerDisclosureFeedback();
                    props.onToggleRow(row.id);
                  }
                }}
                onLongPress={() => props.onCopyRow(row.id, row.getCopyText())}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? pressedBackground : "transparent",
                })}
                className="rounded-md px-0.5 py-0.5"
              >
                <View className="min-h-9 flex-row items-center gap-1.5">
                  <View className="h-5 w-5 shrink-0 items-center justify-center">
                    <WorkRowIcon row={row} iconSubtleColor={props.iconSubtleColor} />
                  </View>

                  {filePath ? (
                    <RowText className="min-w-0 flex-1 font-mono text-xs" numberOfLines={1}>
                      <Text className="text-foreground-muted opacity-60">{filePath.prefix}</Text>
                      <Text className="text-foreground">{filePath.name}</Text>
                    </RowText>
                  ) : hideSummaryLabel ? (
                    <RowText
                      className="min-w-0 flex-1 font-mono text-xs text-foreground-muted"
                      numberOfLines={1}
                    >
                      {detail}
                    </RowText>
                  ) : (
                    <RowText className="min-w-0 flex-1 text-xs text-foreground" numberOfLines={1}>
                      <Text
                        className={cn(
                          "font-t3-medium text-foreground",
                          textIsDestructive && "text-rose-600 dark:text-rose-400",
                        )}
                      >
                        {row.summary}
                      </Text>
                      {detail ? (
                        <Text className="text-foreground-muted opacity-60"> {detail}</Text>
                      ) : null}
                    </RowText>
                  )}

                  <View className="shrink-0 flex-row items-center gap-px">
                    {diffStats ? (
                      <WorkRowDiffStat
                        additions={diffStats.additions}
                        deletions={diffStats.deletions}
                      />
                    ) : null}
                    {props.copiedRowId === row.id ? (
                      <Text className="pr-1 font-t3-medium text-3xs text-emerald-600 dark:text-emerald-400">
                        Copied
                      </Text>
                    ) : null}
                    <View className="h-4 w-4 items-center justify-center">
                      {canExpand ? (
                        <SymbolView
                          name={
                            expanded
                              ? { ios: "chevron.up", android: "keyboard_arrow_up" }
                              : { ios: "chevron.down", android: "keyboard_arrow_down" }
                          }
                          size={11}
                          tintColor={props.iconSubtleColor}
                          type="monochrome"
                        />
                      ) : null}
                    </View>
                    {/* Success is the default outcome — only surface deviations. */}
                    {row.status === "failure" || row.status === "neutral" ? (
                      <View className="h-4 w-4 items-center justify-center">
                        <SymbolView
                          name={
                            row.status === "failure"
                              ? { ios: "xmark", android: "close" }
                              : { ios: "minus", android: "remove" }
                          }
                          size={11}
                          tintColor={row.status === "failure" ? "#e11d48" : props.iconSubtleColor}
                          type="monochrome"
                        />
                      </View>
                    ) : null}
                  </View>
                </View>
              </Pressable>

              {expanded && canExpand ? (
                <View className="ml-7 border-l border-neutral-300/60 pb-1.5 pl-3 pt-0.5 dark:border-white/[0.12]">
                  <ThreadActivityInspector
                    activity={row}
                    currentThreadId={props.currentThreadId}
                    environmentId={props.environmentId}
                    iconColor={props.iconSubtleColor}
                    workspaceRoot={props.workspaceRoot}
                  />
                </View>
              ) : null}
              {row.prominent ? (
                <ThreadActivityThreadLink
                  activity={row}
                  environmentId={props.environmentId}
                  iconColor={props.iconSubtleColor}
                />
              ) : null}
            </Animated.View>
          );
        })}
      </View>

      {hasOverflow ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: props.expanded }}
          accessibilityLabel={
            props.expanded
              ? `Show fewer ${overflowNoun}`
              : `Show ${hiddenCount} previous ${overflowNoun}`
          }
          hitSlop={4}
          onPress={() => {
            triggerDisclosureFeedback();
            props.onToggleGroup();
          }}
          style={({ pressed }) => ({
            backgroundColor: pressed ? pressedBackground : "transparent",
          })}
          className="min-h-9 flex-row items-center gap-1.5 rounded-md px-0.5 py-0.5"
        >
          <View className="h-5 w-5 items-center justify-center">
            <SymbolView
              name={props.expanded ? "chevron.up" : "chevron.down"}
              size={13}
              tintColor={props.iconSubtleColor}
              type="monochrome"
            />
          </View>
          <Text className="font-t3-medium text-xs text-foreground opacity-80">
            {props.expanded
              ? `Show fewer ${overflowNoun}`
              : `+${hiddenCount} previous ${overflowNoun}`}
          </Text>
          {!props.expanded ? (
            <>
              <View className="flex-1" />
              <WorkRowDiffStat
                additions={hiddenStats.additions}
                deletions={hiddenStats.deletions}
              />
            </>
          ) : null}
        </Pressable>
      ) : null}
    </View>
  );
}

export function ThreadWorkGroupToggle(props: {
  readonly expanded: boolean;
  readonly hiddenAdditions?: number;
  readonly hiddenCount: number;
  readonly hiddenDeletions?: number;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly onlyToolActivities: boolean;
  readonly onToggle: () => void;
}) {
  const colorScheme = useColorScheme();
  const pressedBackground = colorScheme === "dark" ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.035)";
  const noun = threadWorkLogOverflowNoun(props.onlyToolActivities, props.hiddenCount);

  return (
    <View className="-mx-1 mb-1 px-1">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        accessibilityLabel={
          props.expanded ? `Show fewer ${noun}` : `Show ${props.hiddenCount} previous ${noun}`
        }
        hitSlop={4}
        onPress={() => {
          triggerDisclosureFeedback();
          props.onToggle();
        }}
        style={({ pressed }) => ({
          backgroundColor: pressed ? pressedBackground : "transparent",
        })}
        className="min-h-8 flex-row items-center gap-1.5 rounded-md px-0.5"
      >
        <View className="h-[18px] w-5 items-center justify-center">
          <SymbolView
            name={props.expanded ? "chevron.up" : "chevron.down"}
            size={12}
            tintColor={props.iconSubtleColor}
            type="monochrome"
          />
        </View>
        <Text className="font-t3-medium text-xs text-foreground opacity-80">
          {props.expanded ? `Show fewer ${noun}` : `+${props.hiddenCount} previous ${noun}`}
        </Text>
        {!props.expanded ? (
          <>
            <View className="flex-1" />
            <WorkRowDiffStat
              additions={props.hiddenAdditions ?? 0}
              deletions={props.hiddenDeletions ?? 0}
            />
          </>
        ) : null}
      </Pressable>
    </View>
  );
}
