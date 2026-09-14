import type { EnvironmentId, HermesWorkCommand, HermesWorkQueryResult } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRef, useState } from "react";
import { Alert, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { AppText as Text } from "../../../components/AppText";
import { hermesEnvironment } from "../../../state/hermes";
import { useAtomCommand } from "../../../state/use-atom-command";
import { DetailsDivider, DetailsNoticeButton, DetailsRow, DetailsSection } from "./detailsRows";

/** Native Hermes facts belong beside the thread, without presenting its workspace as a git project. */
export function ThreadDetailsHermes(props: {
  environmentId: EnvironmentId;
  details: NonNullable<HermesWorkQueryResult["threadDetails"]>;
  diagnostics: readonly string[];
  refreshing: boolean;
  onRefresh: () => void;
  onManage: () => void;
}) {
  const mutate = useAtomCommand(hermesEnvironment.workMutate, { label: "Update thread schedule" });
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const copy = (value: string) => {
    void Clipboard.setStringAsync(value).catch((error) =>
      Alert.alert("Could not copy", String(error)),
    );
  };
  const run = async (command: HermesWorkCommand) => {
    if (
      inFlight.current ||
      props.refreshing ||
      !props.details.providerInstanceId ||
      !props.details.profile
    )
      return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await mutate({
        environmentId: props.environmentId,
        input: {
          providerInstanceId: props.details.providerInstanceId,
          profile: props.details.profile,
          command,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            "Could not update schedule",
            error instanceof Error ? error.message : String(error),
          );
        }
      } else props.onRefresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <DetailsSection
        title="Hermes conversation"
        footer="Workspace paths refer to the hosting environment."
      >
        {props.details.status !== "bound" ? (
          <Text className="px-4 py-3 text-sm text-foreground-muted">
            {props.details.status === "unbound"
              ? "This thread has no native Hermes session association."
              : "Native session details are currently unavailable."}
          </Text>
        ) : null}
        <DetailsRow
          icon="person.crop.circle"
          title="Assistant profile"
          subtitle={props.details.profile ?? "Profile unavailable"}
          showChevron={false}
        />
        <DetailsDivider />
        <DetailsRow
          icon="bubble.left.and.bubble.right"
          title="Hermes session"
          subtitle={props.details.sessionId ?? "Native session unavailable"}
          showChevron={false}
          onPress={props.details.sessionId ? () => copy(props.details.sessionId ?? "") : undefined}
          trailing={
            props.details.sessionId ? (
              <Text className="text-xs text-foreground-muted">Copy</Text>
            ) : undefined
          }
        />
        <DetailsDivider />
        <DetailsRow
          icon="folder"
          title="Native workspace"
          subtitle={props.details.workspacePath ?? "Workspace path unavailable"}
          showChevron={false}
          onPress={
            props.details.workspacePath ? () => copy(props.details.workspacePath ?? "") : undefined
          }
          trailing={
            props.details.workspacePath ? (
              <Text className="text-xs text-foreground-muted">Copy</Text>
            ) : undefined
          }
        />
        <DetailsDivider />
        <DetailsRow
          icon="server.rack"
          title="Background service"
          subtitle={
            props.details.gatewayState ??
            (props.details.gatewayRunning === true
              ? "Running"
              : props.details.gatewayRunning === false
                ? "Stopped"
                : "Status unavailable")
          }
          showChevron={false}
        />
      </DetailsSection>
      <DetailsSection
        title="Scheduled tasks"
        footer="Pausing affects future runs; work already running continues."
        action={<DetailsNoticeButton label="Work settings" onPress={props.onManage} />}
      >
        {props.details.schedulesAvailable === false && props.details.schedules.length > 0 ? (
          <Text className="px-4 py-3 text-sm text-foreground-muted">
            Some linked schedules could not be confirmed. This list may be incomplete.
          </Text>
        ) : null}
        {props.details.schedules.length === 0 ? (
          <Text className="px-4 py-3 text-sm text-foreground-muted">
            {props.details.status === "bound" && props.details.schedulesAvailable !== false
              ? "No verified scheduled tasks are linked to this conversation."
              : "Linked schedules cannot be confirmed."}
          </Text>
        ) : (
          props.details.schedules.map((schedule, index) => (
            <View key={schedule.id}>
              {index > 0 ? <DetailsDivider /> : null}
              <DetailsRow
                icon="calendar.badge.clock"
                title={schedule.name}
                subtitle={`${schedule.schedule} · ${schedule.paused ? "Paused" : "Active"}`}
                showChevron={false}
              />
              <View className="gap-2 px-4 pb-3">
                <Text className="text-xs text-foreground-muted">
                  {schedule.relationship === "created_here"
                    ? "Created in this conversation"
                    : "This conversation is a run of this task"}
                </Text>
                <Text className="text-sm text-foreground-muted">{schedule.prompt}</Text>
                {schedule.nextRunAt ? (
                  <Text className="text-xs text-foreground-muted">
                    Next run: {schedule.nextRunAt}
                  </Text>
                ) : null}
                {schedule.lastStatus ? (
                  <Text className="text-xs text-foreground-muted">
                    Last run: {schedule.lastStatus}
                  </Text>
                ) : null}
                <Text className="text-xs text-foreground-muted">Delivery: {schedule.deliver}</Text>
                {schedule.lastError ? (
                  <Text className="text-xs text-red-500">Execution: {schedule.lastError}</Text>
                ) : null}
                {schedule.lastDeliveryError ? (
                  <Text className="text-xs text-red-500">
                    Delivery: {schedule.lastDeliveryError}
                  </Text>
                ) : null}
                <View className="flex-row flex-wrap gap-2">
                  <DetailsNoticeButton
                    disabled={
                      busy ||
                      props.refreshing ||
                      !props.details.providerInstanceId ||
                      !props.details.profile
                    }
                    label={schedule.paused ? "Resume" : "Pause"}
                    onPress={() => {
                      void run({
                        type: schedule.paused ? "schedule.resume" : "schedule.pause",
                        id: schedule.id,
                      });
                    }}
                  />
                  <DetailsNoticeButton
                    disabled={
                      busy ||
                      props.refreshing ||
                      !props.details.providerInstanceId ||
                      !props.details.profile
                    }
                    label="Run now"
                    onPress={() => {
                      void run({ type: "schedule.run", id: schedule.id });
                    }}
                  />
                </View>
              </View>
            </View>
          ))
        )}
      </DetailsSection>
      {[...new Set(props.diagnostics)].map((message) => (
        <Text key={message} className="px-1 text-xs text-foreground-muted">
          {message}
        </Text>
      ))}
    </>
  );
}
