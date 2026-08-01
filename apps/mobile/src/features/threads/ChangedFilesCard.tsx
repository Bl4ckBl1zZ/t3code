import type { OrchestrationCheckpointFile } from "@t3tools/contracts";
import { memo, useMemo } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { buildTurnDiffTree, summarizeTurnDiffStats, type TurnDiffTreeNode } from "./turnDiffTree";

function DiffStatLabel(props: { readonly additions: number; readonly deletions: number }) {
  return (
    <View className="flex-row items-center gap-1.5">
      <Text className="font-t3-bold text-xs tabular-nums text-emerald-600">+{props.additions}</Text>
      <Text className="font-t3-bold text-xs tabular-nums text-rose-600">-{props.deletions}</Text>
    </View>
  );
}

function TreeNodeRows(props: {
  readonly nodes: ReadonlyArray<TurnDiffTreeNode>;
  readonly depth: number;
  readonly iconSubtleColor: ColorValue;
  readonly onOpenFile: (filePath: string) => void;
}) {
  return (
    <>
      {props.nodes.map((node) => {
        const leftPadding = 4 + props.depth * 14;
        if (node.kind === "directory") {
          return (
            <View key={`dir:${node.path}`}>
              <View
                className="min-h-8 flex-row items-center gap-1.5 py-1 pr-1"
                style={{ paddingLeft: leftPadding }}
              >
                <SymbolView
                  name="folder.fill"
                  size={13}
                  tintColor={props.iconSubtleColor}
                  type="monochrome"
                />
                <Text
                  className="min-w-0 flex-1 font-mono text-xs text-neutral-600 dark:text-neutral-400"
                  numberOfLines={1}
                >
                  {node.name}
                </Text>
                {node.stat.additions > 0 || node.stat.deletions > 0 ? (
                  <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
                ) : null}
              </View>
              <TreeNodeRows
                nodes={node.children}
                depth={props.depth + 1}
                iconSubtleColor={props.iconSubtleColor}
                onOpenFile={props.onOpenFile}
              />
            </View>
          );
        }

        return (
          <Pressable
            key={`file:${node.path}`}
            accessibilityRole="button"
            className="min-h-8 flex-row items-center gap-1.5 rounded-lg py-1 pr-1 active:bg-neutral-200/60 dark:active:bg-white/6"
            style={{ paddingLeft: leftPadding }}
            onPress={() => props.onOpenFile(node.path)}
          >
            <SymbolView
              name="doc.text"
              size={13}
              tintColor={props.iconSubtleColor}
              type="monochrome"
            />
            <Text
              className="min-w-0 flex-1 font-mono text-xs text-neutral-700 dark:text-neutral-300"
              numberOfLines={1}
            >
              {node.name}
            </Text>
            {node.stat ? (
              <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
            ) : null}
          </Pressable>
        );
      })}
    </>
  );
}

export const ChangedFilesCard = memo(function ChangedFilesCard(props: {
  readonly files: ReadonlyArray<OrchestrationCheckpointFile>;
  readonly expanded: boolean;
  readonly iconSubtleColor: ColorValue;
  readonly onToggleExpanded: () => void;
  readonly onOpenDiff: (filePath?: string) => void;
}) {
  const summaryStat = useMemo(() => summarizeTurnDiffStats(props.files), [props.files]);
  const treeNodes = useMemo(
    () => (props.expanded ? buildTurnDiffTree(props.files) : []),
    [props.expanded, props.files],
  );

  return (
    <View className="mt-3 rounded-[16px] border border-neutral-200 bg-neutral-100/80 p-2 dark:border-white/6 dark:bg-neutral-900/80">
      <View className="flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: props.expanded }}
          hitSlop={4}
          className="min-h-8 min-w-0 flex-1 flex-row items-center gap-1.5 rounded-lg px-1"
          onPress={props.onToggleExpanded}
        >
          <SymbolView
            name={props.expanded ? "chevron.down" : "chevron.right"}
            size={12}
            tintColor={props.iconSubtleColor}
            type="monochrome"
          />
          <Text className="font-t3-bold text-xs text-neutral-950 dark:text-neutral-50">
            {props.files.length} changed file{props.files.length === 1 ? "" : "s"}
          </Text>
          {summaryStat.additions > 0 || summaryStat.deletions > 0 ? (
            <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} />
          ) : null}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open diff"
          className="rounded-full border border-neutral-200 bg-white px-2.5 py-1.5 active:bg-neutral-100 dark:border-white/6 dark:bg-neutral-950/70 dark:active:bg-neutral-900"
          onPress={() => props.onOpenDiff(props.files[0]?.path)}
        >
          <Text className="font-t3-bold text-xs text-neutral-600 dark:text-neutral-300">
            Open diff
          </Text>
        </Pressable>
      </View>
      {props.expanded ? (
        <View className="pt-1">
          <TreeNodeRows
            nodes={treeNodes}
            depth={0}
            iconSubtleColor={props.iconSubtleColor}
            onOpenFile={props.onOpenDiff}
          />
        </View>
      ) : null}
    </View>
  );
});
