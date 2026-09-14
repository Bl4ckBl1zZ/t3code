import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import type { EnvironmentId, HermesWorkGroupsMutateInput } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { uuidv4 } from "../../lib/uuid";
import { hermesEnvironment } from "../../state/hermes";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

import { useWorkRefresh } from "./useWorkRefresh";

export function HermesWorkGroups({
  environmentId,
  providerInstanceId,
  profile,
}: {
  environmentId: EnvironmentId;
  providerInstanceId: string;
  profile: string;
}) {
  const [roomId, setRoomId] = useState<string | undefined>();
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [cursor, setCursor] = useState(0);
  const query = useEnvironmentQuery(
    hermesEnvironment.workGroupsQuery({
      environmentId,
      input: { providerInstanceId, profile, ...(roomId ? { roomId, cursor } : {}), offset },
    }),
  );
  useWorkRefresh(query.refresh, !busy);
  const profiles = useEnvironmentQuery(
    hermesEnvironment.workQuery({
      environmentId,
      input: { providerInstanceId, profile, section: "profiles" },
    }),
  );
  const mutate = useAtomCommand(hermesEnvironment.workGroupsMutate, {
    label: "Hermes group update",
  });
  const execute = async (command: HermesWorkGroupsMutateInput["command"]) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await mutate({
        environmentId,
        input: { providerInstanceId, profile, operationId: uuidv4(), command },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            "Group update failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }
      if (command.type === "send") setMessage("");
      if (command.type === "create") {
        setRoomId(command.roomId);
        setCursor(0);
        setOffset(0);
        setMembers([]);
      }
      if (command.type === "remove") {
        setRoomId(undefined);
        setCursor(0);
        setOffset(0);
      }

      query.refresh();
    } finally {
      setBusy(false);
    }
  };
  const button = (label: string, onPress: () => void, disabled = false) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      disabled={busy || disabled}
      onPress={onPress}
      className="rounded-xl bg-card p-3"
    >
      <Text>{label}</Text>
    </Pressable>
  );
  return (
    <View className="gap-3">
      <Text className="font-t3-semibold">Assistant groups</Text>
      {query.error ? <Text className="text-red-500">{query.error}</Text> : null}
      {button("Refresh groups", query.refresh, query.isPending)}
      {roomId ? (
        <>
          {button("Back to groups", () => {
            setCursor(0);
            setRoomId(undefined);
            setOffset(0);
          })}
          {query.data?.events.map((event) => (
            <View key={event.id} className="rounded-xl bg-card p-3">
              <Text className="font-t3-semibold">
                {event.actor} · {event.kind}
              </Text>
              <Text selectable>{event.text}</Text>
            </View>
          ))}
          {query.data?.hasMore
            ? button("Next messages", () => setCursor(query.data?.cursor ?? 0))
            : null}
          {cursor > 0 ? button("First messages", () => setCursor(0)) : null}
          <TextInput
            accessibilityLabel="Group message"
            placeholder="Message the assistants. Use @handle to mention one."
            value={message}
            onChangeText={setMessage}
            multiline
            className="rounded-xl border border-secondary-border p-3 text-foreground"
          />
          {button(
            "Send message",
            () => {
              void execute({
                type: "send",
                roomId,
                eventId: uuidv4(),
                threadId: uuidv4(),
                text: message.trim(),
              });
            },
            !message.trim(),
          )}
          {button("Stop current work", () => {
            void execute({ type: "stop", roomId });
          })}
          <TextInput
            accessibilityLabel="Group name"
            placeholder="New group name"
            value={name}
            onChangeText={setName}
            className="rounded-xl border border-secondary-border p-3 text-foreground"
          />
          {button(
            "Rename group",
            () => {
              void execute({ type: "rename", roomId, eventId: uuidv4(), name: name.trim() });
            },
            !name.trim(),
          )}
          {button("Remove group", () =>
            showConfirmDialog({
              title: "Remove group?",
              message: "This removes the group from Hermes.",
              confirmText: "Remove",
              destructive: true,
              onConfirm: () => {
                void execute({ type: "remove", roomId });
              },
            }),
          )}
        </>
      ) : (
        <>
          {query.data?.groups.map((group) =>
            button(group.name, () => {
              setCursor(Math.max(0, group.latestSequence - 100));
              setRoomId(group.id);
              setOffset(0);
              setName(group.name);
            }),
          )}
          {query.data?.nextOffset !== null && query.data?.nextOffset !== undefined
            ? button("Next groups", () => setOffset(query.data?.nextOffset ?? 0))
            : null}
          {offset > 0 ? button("First groups", () => setOffset(0)) : null}
          <TextInput
            accessibilityLabel="New group name"
            placeholder="New group name"
            value={name}
            onChangeText={setName}
            className="rounded-xl border border-secondary-border p-3 text-foreground"
          />
          <Text>Select two to six assistants. Group membership is fixed when created.</Text>
          {profiles.data?.profiles.map((item) =>
            button(
              `${members.includes(item.name) ? "✓ " : ""}${item.name}`,
              () =>
                setMembers((current) =>
                  current.includes(item.name)
                    ? current.filter((value) => value !== item.name)
                    : [...current, item.name],
                ),
              !members.includes(item.name) && members.length >= 6,
            ),
          )}
          {button(
            "Create group",
            () => {
              void execute({
                type: "create",
                roomId: uuidv4(),
                name: name.trim(),
                members: members.map((member) => ({
                  id: uuidv4(),
                  profile: member,
                  handle: member,
                  name: member,
                })),
              });
            },
            !name.trim() || members.length < 2,
          )}
        </>
      )}
    </View>
  );
}
