import {
  requiresDefaultBranchConfirmation,
  resolveQuickAction,
  type GitActionRequestInput,
  type GitQuickAction,
} from "@t3tools/client-runtime/state/vcs";
import { EnvironmentId, ThreadId, type ProjectScript } from "@t3tools/contracts";
import { resolveThreadChangeStat } from "@t3tools/shared/git";
import { CommonActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { SFSymbol } from "expo-symbols";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Platform, RefreshControl, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { AppText as Text } from "../../../components/AppText";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { useThemeColor } from "../../../lib/useThemeColor";
import { nativeHeaderScrollEdgeEffects } from "../../../native/StackHeader";
import { useEnvironmentQuery } from "../../../state/query";
import {
  useRemoteConnections,
  useRemoteEnvironmentRuntime,
} from "../../../state/use-remote-environment-registry";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { useT3ProjectFilePreviewUrl } from "../../../state/use-t3-project-file";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { vcsEnvironment } from "../../../state/vcs";
import { statusSummary } from "../git/gitSheetComponents";
import {
  basename,
  projectScriptMenuIcon,
  projectScriptMenuLabel,
} from "../../terminal/terminalMenu";
import { useThreadTerminalActions } from "../../terminal/useThreadTerminalActions";
import {
  DetailsDivider,
  DetailsNotice,
  DetailsNoticeButton,
  DetailsRow,
  DetailsSection,
} from "./detailsRows";
import { ThreadDetailsAutomations } from "./ThreadDetailsAutomations";
import { ThreadDetailsBackgroundTasks } from "./ThreadDetailsBackgroundTasks";
import { ThreadDetailsLineage } from "./ThreadDetailsLineage";
import { ThreadDetailsPorts } from "./ThreadDetailsPorts";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type ThreadDetailsSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

function quickActionIcon(kind: string, action: string | undefined): SFSymbol {
  if (kind === "run_pull") return "arrow.down.circle";
  if (kind === "open_pr") return "arrow.up.right.circle";
  if (action === "commit") return "checkmark.circle";
  if (action === "push" || action === "commit_push") return "arrow.up.circle";
  return "arrow.up.right.circle";
}

/**
 * The thread details sheet — the mobile presentation of the desktop thread
 * details panel, opened from the `line.3.horizontal.decrease` header button.
 *
 * Same sections in the same order (Workspace, Ports, Background Tasks, Version
 * Control, Automations, Lineage), each hiding itself when it has nothing to
 * report, so the sheet is only ever as tall as the thread has facts.
 */
export function ThreadDetailsSheet(props: ThreadDetailsSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const { selectedThread, selectedThreadProject, selectedEnvironmentConnection } =
    useThreadSelection();
  const { selectedThreadCwd, selectedThreadWorktreePath } = useSelectedThreadWorktree();
  const environmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const { onReconnectEnvironment } = useRemoteConnections();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const { activeProjectScriptIds, runProjectScript } = useThreadTerminalActions();
  const pinnedPreviewUrl = useT3ProjectFilePreviewUrl(environmentId, selectedThreadCwd);

  const foregroundColor = String(useThemeColor("--color-foreground"));
  const sheetColor = String(useThemeColor("--color-sheet"));

  const gitStatus = useEnvironmentQuery(
    selectedThreadCwd !== null
      ? vcsEnvironment.status({ environmentId, input: { cwd: selectedThreadCwd } })
      : null,
  );

  useEffect(() => {
    void gitActions.refreshSelectedThreadGitStatus({ quiet: true });
  }, [gitActions]);

  const projectScripts = selectedThreadProject?.scripts ?? [];
  const status = gitStatus.data;
  const currentBranchLabel = status?.refName ?? selectedThread?.branch ?? "Detached HEAD";
  const busy = gitState.gitOperationLabel !== null;
  const isRepo = status?.isRepo ?? true;
  const connectionState = environmentRuntime?.connectionState ?? "available";
  const connectionIssue = connectionState !== "connected" && connectionState !== "available";
  const isReconnecting = connectionState === "connecting" || connectionState === "reconnecting";

  const quickAction = useMemo<GitQuickAction>(
    () =>
      isRepo
        ? resolveQuickAction(
            status ?? null,
            busy,
            status?.isDefaultRef ?? false,
            status?.hasPrimaryRemote ?? false,
          )
        : {
            label: "Git unavailable",
            disabled: true,
            kind: "show_hint" as const,
            hint: "This workspace is not a git repository.",
          },
    [busy, isRepo, status],
  );

  const close = useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
  }, [navigation]);

  /** Sheets stack over the thread, so every push has to dismiss this one first. */
  const navigateFromSheet = useCallback(
    (name: string, params: Record<string, unknown>) => {
      close();
      navigation.dispatch(CommonActions.navigate(name, params));
    },
    [close, navigation],
  );

  const openExistingPr = useCallback(async () => {
    const prUrl = status?.pr?.state === "open" ? status.pr.url : null;
    if (!prUrl) {
      Alert.alert("No open PR", "This branch does not have an open pull request.");
      return;
    }
    if (!(await tryOpenExternalUrl(prUrl, "pull-request"))) {
      Alert.alert("Unable to open PR", "The pull request could not be opened.");
    }
  }, [status]);

  const runGitAction = useCallback(
    async (input: GitActionRequestInput) => {
      const confirmableAction =
        input.action === "push" ||
        input.action === "create_pr" ||
        input.action === "commit_push" ||
        input.action === "commit_push_pr"
          ? input.action
          : null;
      const branchName = status?.refName;
      if (
        branchName &&
        confirmableAction &&
        !input.featureBranch &&
        requiresDefaultBranchConfirmation(input.action, status?.isDefaultRef ?? false)
      ) {
        navigateFromSheet("GitConfirm", {
          environmentId: String(environmentId),
          threadId: String(threadId),
          confirmAction: confirmableAction,
          branchName,
          includesCommit: String(
            input.action === "commit_push" || input.action === "commit_push_pr",
          ),
        });
        return;
      }

      close();
      await gitActions.onRunSelectedThreadGitAction(input);
    },
    [close, environmentId, gitActions, navigateFromSheet, status, threadId],
  );

  const runQuickAction = useCallback(async () => {
    if (quickAction.kind === "open_pr") {
      await openExistingPr();
      return;
    }
    if (quickAction.kind === "run_pull") {
      close();
      await gitActions.onPullSelectedThreadBranch();
      return;
    }
    if (quickAction.kind === "run_action" && quickAction.action) {
      await runGitAction({ action: quickAction.action });
    }
  }, [close, gitActions, openExistingPr, quickAction, runGitAction]);

  const handleRunScript = useCallback(
    (script: ProjectScript) => {
      close();
      void runProjectScript(script);
    },
    [close, runProjectScript],
  );

  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const handlePullRefresh = useCallback(async () => {
    setIsPullRefreshing(true);
    try {
      await gitActions.refreshSelectedThreadGitStatus();
    } finally {
      setIsPullRefreshing(false);
    }
  }, [gitActions]);

  const workspaceLabel =
    basename(selectedThreadWorktreePath) ??
    selectedThreadProject?.title ??
    basename(selectedThreadProject?.workspaceRoot ?? null) ??
    "Workspace";
  // Counts whichever diff "Review changes" leads with: uncommitted edits, or
  // what the branch has committed once the working tree is clean.
  const changeStat = resolveThreadChangeStat(status ?? null);
  const insertions = changeStat?.insertions ?? 0;
  const deletions = changeStat?.deletions ?? 0;

  const content = (
    <ScrollView
      className="flex-1 bg-screen"
      contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, gap: 16 }}
      refreshControl={
        <RefreshControl refreshing={isPullRefreshing} onRefresh={() => void handlePullRefresh()} />
      }
      showsVerticalScrollIndicator={false}
    >
      {connectionIssue ? (
        <DetailsNotice
          actions={
            <>
              <DetailsNoticeButton
                disabled={isReconnecting}
                label={isReconnecting ? "Reconnecting…" : "Reconnect"}
                onPress={() => onReconnectEnvironment(environmentId)}
                tone="primary"
              />
              <DetailsNoticeButton
                label="Connections"
                onPress={() => navigateFromSheet("Connections", {})}
              />
            </>
          }
          body={
            environmentRuntime?.connectionError ??
            "Reconnect this environment before sending messages or running actions."
          }
          title="Environment unavailable"
        />
      ) : null}

      <DetailsSection title="Workspace">
        <DetailsRow
          icon="server.rack"
          subtitle={connectionState}
          onPress={() => navigateFromSheet("Connections", {})}
          title={selectedEnvironmentConnection?.environmentLabel ?? String(environmentId)}
        />
        {/* A Hermes conversation has no project, so it has no folder to name
            and nothing under it to browse or run. */}
        {selectedThreadCwd !== null ? (
          <>
            <DetailsDivider />
            <DetailsRow
              icon={selectedThreadWorktreePath ? "arrow.triangle.branch" : "folder"}
              onPress={() =>
                navigateFromSheet("GitBranches", {
                  environmentId: String(environmentId),
                  threadId: String(threadId),
                })
              }
              subtitle={selectedThreadCwd}
              title={workspaceLabel}
              trailing={
                <Text className="text-2xs text-foreground-muted">
                  {selectedThreadWorktreePath ? "Worktree" : "Project folder"}
                </Text>
              }
            />
            <DetailsDivider />
            <DetailsRow
              icon="folder"
              onPress={() =>
                navigateFromSheet("ThreadFiles", {
                  environmentId: String(environmentId),
                  threadId: String(threadId),
                })
              }
              subtitle="Browse this thread's workspace"
              title="Files"
            />
          </>
        ) : null}
        {projectScripts.map((script) => {
          const isActive = activeProjectScriptIds.includes(script.id);
          return (
            <View key={script.id}>
              <DetailsDivider />
              <DetailsRow
                icon={(isActive ? "stop.fill" : projectScriptMenuIcon(script.icon)) as SFSymbol}
                onPress={() => handleRunScript(script)}
                showChevron={false}
                subtitle={script.command}
                title={
                  isActive
                    ? `Stop ${projectScriptMenuLabel(script)}`
                    : projectScriptMenuLabel(script)
                }
              />
            </View>
          );
        })}
      </DetailsSection>

      <ThreadDetailsPorts
        environmentId={environmentId}
        pinnedPreviewUrl={pinnedPreviewUrl}
        scripts={projectScripts}
        threadId={threadId}
      />

      <ThreadDetailsBackgroundTasks environmentId={environmentId} threadId={threadId} />

      {selectedThreadCwd !== null ? (
        <DetailsSection title="Version Control">
          <DetailsRow
            icon="point.topleft.down.curvedto.point.bottomright.up"
            onPress={() =>
              navigateFromSheet("GitBranches", {
                environmentId: String(environmentId),
                threadId: String(threadId),
              })
            }
            subtitle={statusSummary(status)}
            title={currentBranchLabel}
          />
          <DetailsDivider />
          <DetailsRow
            detail={
              insertions > 0 || deletions > 0 ? (
                <Text className="text-2xs tabular-nums text-foreground-muted">
                  +{insertions} −{deletions}
                </Text>
              ) : undefined
            }
            disabled={busy || !isRepo}
            icon="text.bubble"
            onPress={() => navigateFromSheet("ThreadReview", { environmentId, threadId })}
            subtitle="Turn diffs and worktree changes"
            title="Review changes"
          />
          <DetailsDivider />
          <DetailsRow
            disabled={quickAction.disabled}
            icon={quickActionIcon(quickAction.kind, quickAction.action)}
            onPress={() => void runQuickAction()}
            showChevron={false}
            subtitle={
              quickAction.disabled ? (quickAction.hint ?? "This action is unavailable.") : null
            }
            title={quickAction.label}
          />
          <DetailsDivider />
          <DetailsRow
            icon="ellipsis"
            onPress={() =>
              navigateFromSheet("GitOverview", {
                environmentId: String(environmentId),
                threadId: String(threadId),
              })
            }
            subtitle="Commit, files, branches"
            title="More git actions"
          />
        </DetailsSection>
      ) : null}

      <ThreadDetailsAutomations environmentId={environmentId} threadId={threadId} />

      <ThreadDetailsLineage environmentId={environmentId} onNavigate={close} threadId={threadId} />
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // A plain screen presented as a formSheet never renders a stack header, so
    // — like the git and settings sheets — the header comes from a nested
    // native stack INSIDE the sheet.
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-details-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: sheetColor, flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={foregroundColor}
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              title={selectedThread?.title ?? "Thread details"}
              titleColor={foregroundColor}
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AndroidSheetHeader
        onBack={close}
        subtitle={selectedThreadProject?.title ?? null}
        title={selectedThread?.title ?? "Thread details"}
      />
      {content}
    </View>
  );
}
