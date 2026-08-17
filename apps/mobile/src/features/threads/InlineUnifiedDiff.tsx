import { memo, useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { resolveNativeReviewDiffView } from "../diffs/nativeReviewDiffSurface";
import {
  buildNativeReviewDiffData,
  createNativeReviewDiffTheme,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
} from "../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../review/reviewModel";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";

/**
 * Renders a raw unified diff with the native review diff surface (syntax
 * highlighting, +/− tones), falling back to a horizontally scrollable
 * monospace view when the native component is unavailable.
 */
export const InlineUnifiedDiff = memo(function InlineUnifiedDiff(props: {
  readonly diff: string;
  readonly cacheScope: string;
  readonly maxHeight?: number;
}) {
  const { nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const { themeAppearance: appearanceScheme, themeId } = useAppearancePreferences();
  const NativeReviewDiffView = resolveNativeReviewDiffView();
  const maxHeight = props.maxHeight ?? 360;

  const parsedDiff = useMemo(
    () => buildReviewParsedDiff(props.diff, props.cacheScope),
    [props.diff, props.cacheScope],
  );
  const nativeReviewDiffData = useMemo(() => buildNativeReviewDiffData(parsedDiff), [parsedDiff]);
  const compactNativeRows = useMemo(
    () => nativeReviewDiffData.rows.filter((row) => row.kind !== "file"),
    [nativeReviewDiffData.rows],
  );
  const nativeReviewDiffTheme = useMemo(
    () => createNativeReviewDiffTheme(appearanceScheme, themeId),
    [appearanceScheme, themeId],
  );
  const nativeRowsJson = useMemo(() => JSON.stringify(compactNativeRows), [compactNativeRows]);
  const nativeThemeJson = useMemo(
    () => JSON.stringify(nativeReviewDiffTheme),
    [nativeReviewDiffTheme],
  );
  const nativeStyleJson = useMemo(
    () => JSON.stringify(nativeReviewDiffStyle),
    [nativeReviewDiffStyle],
  );
  const nativeDiffHeight = useMemo(
    () =>
      Math.min(
        maxHeight,
        Math.max(
          64,
          compactNativeRows.length * nativeReviewDiffStyle.rowHeight +
            nativeReviewDiffStyle.fileHeaderVerticalMargin,
        ),
      ),
    [compactNativeRows.length, maxHeight, nativeReviewDiffStyle],
  );

  if (NativeReviewDiffView != null && compactNativeRows.length > 0) {
    return (
      <View
        className="overflow-hidden rounded-lg border border-neutral-300/50 dark:border-white/[0.1]"
        collapsable={false}
        style={{ backgroundColor: nativeReviewDiffTheme.background, height: nativeDiffHeight }}
      >
        <NativeReviewDiffView
          collapsable={false}
          style={StyleSheet.absoluteFill}
          appearanceScheme={appearanceScheme}
          contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
          rowHeight={nativeReviewDiffStyle.rowHeight}
          rowsJson={nativeRowsJson}
          styleJson={nativeStyleJson}
          themeJson={nativeThemeJson}
        />
      </View>
    );
  }

  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      directionalLockEnabled
      bounces={false}
      showsHorizontalScrollIndicator={false}
      className="rounded-lg border border-neutral-300/50 dark:border-white/[0.1]"
      style={{ maxHeight }}
    >
      <Text
        selectable
        className="p-2.5 text-2xs leading-[17px] text-foreground-muted"
        style={{ fontFamily: "ui-monospace" }}
      >
        {props.diff}
      </Text>
    </ScrollView>
  );
});
