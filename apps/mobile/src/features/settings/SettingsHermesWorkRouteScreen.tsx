import { useEffect, useState } from "react";
import { useNavigation } from "@react-navigation/native";
import { ThreadId } from "@t3tools/contracts";
import { Alert, Linking, Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  EnvironmentId,
  HermesWorkCommand,
  HermesWorkQueryInput,
  HermesWorkQueryResult,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { useEnvironments } from "../../state/environments";
import { hermesEnvironment } from "../../state/hermes";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

import { HermesSetupCard } from "../hermes/HermesSetupCard";
import { HermesArtifactPreview } from "./HermesArtifactPreview";
import { useWorkRefresh } from "./useWorkRefresh";
import { HermesWorkGroups } from "./HermesWorkGroups";

type Section = HermesWorkQueryInput["section"];
type Form = {
  title: string;
  values: Record<string, string>;
  secrets?: readonly string[];
  toggles?: Record<string, string>;
  help?: string;
  labels?: Record<string, string>;
  submit: (values: Record<string, string>) => HermesWorkCommand;
};

function Action(props: { label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="rounded-xl bg-card px-4 py-3"
    >
      <Text className={props.disabled ? "text-foreground-muted" : "text-foreground"}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function WorkConnection({
  environmentId,
  providerInstanceId,
}: {
  environmentId: EnvironmentId;
  providerInstanceId: string;
}) {
  const navigation = useNavigation();
  const [profile, setProfile] = useState("default");
  const [groupsVisible, setGroupsVisible] = useState(false);
  const [section, setSection] = useState<Section>("profiles");
  const [detail, setDetail] = useState<{ id?: string; path?: string; offset?: number }>({});
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const query = useEnvironmentQuery(
    hermesEnvironment.workQuery({
      environmentId,
      input: { providerInstanceId, profile, section, ...detail },
    }),
  );
  const mutate = useAtomCommand(hermesEnvironment.workMutate, { label: "Hermes Work update" });
  useWorkRefresh(
    query.refresh,
    !busy && form === null && ["schedules", "runs", "run", "sessions", "status"].includes(section),
  );
  const data = query.data;
  const changeSection = (next: Section) => {
    setGroupsVisible(false);
    setSection(next);
    setDetail({});
  };
  const execute = async (command: HermesWorkCommand) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await mutate({
        environmentId,
        input: { providerInstanceId, profile, command },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            "Could not update Work",
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }
      if (command.type === "conversation.open") {
        if (result.value.threadId)
          navigation.navigate("Thread", {
            environmentId,
            threadId: ThreadId.make(result.value.threadId),
          });
        else
          Alert.alert(
            "Could not open conversation",
            "Hermes did not return a conversation reference.",
          );
      }
      setForm(null);
      if (command.type === "profile.rename" && command.name === profile)
        setProfile(command.newName);
      if (command.type === "profile.remove" && command.name === profile) setProfile("default");
      query.refresh();
    } finally {
      setBusy(false);
    }
  };
  const remove = (title: string, command: HermesWorkCommand) =>
    showConfirmDialog({
      title,
      message: "This removes the item from the connected Hermes installation.",
      confirmText: "Remove",
      destructive: true,
      onConfirm: () => {
        void execute(command);
      },
    });
  const scheduleForm = (schedule?: HermesWorkQueryResult["schedules"][number]) =>
    setForm({
      title: schedule ? "Edit scheduled task" : "New scheduled task",
      toggles: { continuity: "Carry forward the previous run’s output" },
      values: {
        continuity: String(schedule?.continuity ?? false),
        name: schedule?.name ?? "",
        prompt: schedule?.prompt ?? "",
        schedule: schedule?.schedule ?? "0 * * * *",
        deliver: schedule?.deliver ?? "local",
        model: schedule?.model ?? "",
      },
      submit: (v) => {
        const fields = {
          continuity: v.continuity === "true",
          name: v.name ?? "",
          prompt: v.prompt ?? "",
          schedule: v.schedule ?? "",
          deliver: v.deliver ?? "local",
          ...(v.model ? { model: v.model } : {}),
        };
        return schedule
          ? { type: "schedule.update", id: schedule.id, paused: schedule.paused, ...fields }
          : { type: "schedule.create", ...fields };
      },
    });
  return (
    <View className="gap-3">
      <Text className="text-sm font-t3-semibold">Assistant: {profile}</Text>
      <Action
        label={groupsVisible ? "Hide assistant groups" : "Assistant groups"}
        onPress={() => setGroupsVisible((value) => !value)}
      />
      {groupsVisible ? (
        <HermesWorkGroups
          key={profile}
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          profile={profile}
        />
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2"
      >
        {(
          [
            ["status", "Connection health"],
            ["profiles", "Assistants"],
            ["sessions", "Conversations"],
            ["schedules", "Scheduled tasks"],
            ["automation", "Automation settings"],
            ["runs", "Run history"],
            ["instructions", "Instructions"],
            ["memory", "Memory"],
            ["skills", "Skills"],
            ["channels", "Messaging"],
            ["files", "Files"],
            ["artifacts", "Generated results"],
          ] as const
        ).map(([value, label]) => (
          <Action key={value} label={label} onPress={() => changeSection(value)} />
        ))}
      </ScrollView>
      <Action
        label={query.isPending ? "Refreshing…" : "Refresh"}
        disabled={query.isPending || busy}
        onPress={query.refresh}
      />
      {query.error ? <Text className="text-red-500">{query.error}</Text> : null}
      {[...new Set(data?.diagnostics ?? [])].map((message) => (
        <Text key={message} className="text-sm text-foreground-muted">
          {message}
        </Text>
      ))}
      {section === "sessions" ? (
        <>
          <Action
            label="New conversation"
            disabled={busy}
            onPress={() => {
              void execute({ type: "conversation.open" });
            }}
          />
          {data?.sessions?.map((session) => (
            <View key={session.id} className="gap-2 rounded-xl bg-card p-3">
              <Text className="font-t3-semibold">{session.title}</Text>
              <Text>{session.preview}</Text>
              <Text>{session.active ? "Running" : "Saved conversation"}</Text>
              <Action
                label="Open conversation"
                disabled={busy}
                onPress={() => {
                  void execute({ type: "conversation.open", sessionId: session.id });
                }}
              />
            </View>
          ))}
        </>
      ) : null}
      {section === "profiles" ? (
        <>
          <Action
            label="New assistant"
            disabled={busy}
            onPress={() =>
              setForm({
                title: "New assistant",
                values: { name: "", description: "", model: "", provider: "" },
                submit: (v) => ({
                  type: "profile.create",
                  name: v.name ?? "",
                  description: v.description ?? "",
                  ...(v.model ? { model: v.model } : {}),
                  ...(v.provider ? { provider: v.provider } : {}),
                }),
              })
            }
          />
          {data?.profiles.map((item) => (
            <View key={item.name} className="gap-2 rounded-xl border border-secondary-border p-3">
              <Text className="font-t3-semibold">{item.name}</Text>
              <Text>{item.description}</Text>
              <Text>{item.model}</Text>
              <Action
                label="Select assistant"
                onPress={() => {
                  setProfile(item.name);
                  changeSection("schedules");
                }}
              />
              <Action
                label="Edit description"
                disabled={busy}
                onPress={() =>
                  setForm({
                    title: "Description",
                    values: { description: item.description },
                    submit: (v) => ({
                      type: "profile.describe",
                      name: item.name,
                      description: v.description ?? "",
                    }),
                  })
                }
              />
              <Action
                label="Change model"
                disabled={busy}
                onPress={() =>
                  setForm({
                    title: "Assistant model",
                    values: { model: item.model, provider: "" },
                    submit: (v) => ({
                      type: "profile.model",
                      name: item.name,
                      model: v.model ?? "",
                      provider: v.provider ?? "",
                    }),
                  })
                }
              />
              {!item.isDefault ? (
                <>
                  <Action
                    label="Rename"
                    disabled={busy}
                    onPress={() =>
                      setForm({
                        title: "Rename assistant",
                        values: { name: item.name },
                        submit: (v) => ({
                          type: "profile.rename",
                          name: item.name,
                          newName: v.name ?? "",
                        }),
                      })
                    }
                  />
                  <Action
                    label="Remove assistant"
                    disabled={busy}
                    onPress={() =>
                      remove("Remove assistant?", { type: "profile.remove", name: item.name })
                    }
                  />
                </>
              ) : null}
            </View>
          ))}
        </>
      ) : null}
      {section === "automation" ? (
        <>
          <Text>Timezone: {data?.automation?.timezone || "Hosting machine default"}</Text>
          <Text>
            Assistant-managed scheduling:{" "}
            {data?.automation?.allowAgentScheduling ? "Enabled" : "Disabled"}
          </Text>
          <Text>
            When enabled, scheduled assistants can create, edit, and remove schedules. This applies
            to all scheduled work for this assistant.
          </Text>
          <Action
            label="Edit automation settings"
            disabled={busy || !data?.automation}
            onPress={() =>
              setForm({
                title: "Automation settings",
                help: "Timezone applies to every schedule for this assistant. Leave blank to use the hosting machine’s timezone.",
                toggles: {
                  allowAgentScheduling:
                    "Allow scheduled assistants to create, edit, and remove schedules",
                },
                values: {
                  timezone: data?.automation?.timezone ?? "",
                  allowAgentScheduling: String(data?.automation?.allowAgentScheduling ?? false),
                },
                submit: (v) => ({
                  type: "automation.save",
                  timezone: v.timezone ?? "",
                  allowAgentScheduling: v.allowAgentScheduling === "true",
                }),
              })
            }
          />
        </>
      ) : null}
      {section === "schedules" ? (
        <>
          <Text className="text-sm text-foreground-muted">
            Schedules use the assistant’s configured timezone and belong to Hermes. Its background
            service must remain running for unattended work. Pausing a schedule does not stop a run
            already in progress.
          </Text>
          <Action label="New scheduled task" disabled={busy} onPress={() => scheduleForm()} />
          {data?.schedules.map((item) => (
            <View key={item.id} className="gap-2 rounded-xl border border-secondary-border p-3">
              <Text className="font-t3-semibold">{item.name}</Text>
              <Text>{item.prompt}</Text>
              <Text>
                {item.schedule} · {item.paused ? "Paused" : "Active"}
              </Text>
              <Text>Delivery: {item.deliver}</Text>
              {item.nextRunAt ? <Text>Next: {item.nextRunAt}</Text> : null}
              {item.lastStatus ? (
                <Text>
                  Last run: {item.lastStatus} {item.lastRunAt}
                </Text>
              ) : null}
              {item.lastError ? <Text className="text-red-500">{item.lastError}</Text> : null}
              {item.lastDeliveryError ? (
                <Text className="text-red-500">Delivery: {item.lastDeliveryError}</Text>
              ) : null}
              <Action label="Edit" disabled={busy} onPress={() => scheduleForm(item)} />
              <Action
                label={item.paused ? "Resume" : "Pause"}
                disabled={busy}
                onPress={() => {
                  void execute({
                    type: item.paused ? "schedule.resume" : "schedule.pause",
                    id: item.id,
                  });
                }}
              />
              <Action
                label="Run now"
                disabled={busy}
                onPress={() => {
                  void execute({ type: "schedule.run", id: item.id });
                }}
              />
              <Action
                label="Remove schedule"
                disabled={busy}
                onPress={() => remove("Remove schedule?", { type: "schedule.remove", id: item.id })}
              />
            </View>
          ))}
        </>
      ) : null}
      {section === "runs"
        ? data?.runs.map((item) => (
            <View key={item.id} className="gap-1 rounded-xl bg-card p-3">
              <Text className="font-t3-semibold">{item.title}</Text>
              <Text>{item.status ?? (item.active ? "Running" : "Outcome unknown")}</Text>
              {item.deliveryStatus ? <Text>Delivery: {item.deliveryStatus}</Text> : null}
              {item.readAt === null ? <Text>Unread</Text> : null}
              <Action
                label="Open run"
                onPress={() => {
                  setSection("run");
                  setDetail({ id: item.id });
                }}
              />
              {item.startedAt !== null ? (
                <Text>{new Date(item.startedAt * 1000).toLocaleString()}</Text>
              ) : null}
            </View>
          ))
        : null}
      {section === "instructions" || section === "memory" ? (
        <>
          {section === "memory" ? (
            <View className="flex-row gap-2">
              {["MEMORY.md", "USER.md"].map((path) => (
                <Action key={path} label={path} onPress={() => setDetail({ path })} />
              ))}
            </View>
          ) : null}
          <Text selectable>{data?.content ?? "No saved content."}</Text>
          <Action
            label="Edit"
            disabled={busy || !data || query.error !== null}
            onPress={() =>
              setForm({
                title: section === "memory" ? "Edit memory" : "Edit instructions",
                values: { content: data?.content ?? "" },
                submit: (v) =>
                  section === "memory"
                    ? {
                        type: "memory.save",
                        file: detail.path === "USER.md" ? "USER.md" : "MEMORY.md",
                        expectedContent: data?.content ?? "",
                        content: v.content ?? "",
                      }
                    : { type: "instructions.save", content: v.content ?? "" },
              })
            }
          />
        </>
      ) : null}
      {section === "skills" ? (
        <>
          <Action
            label="Create skill"
            disabled={busy}
            onPress={() =>
              setForm({
                title: "New skill",
                values: { name: "", content: "" },
                submit: (v) => ({
                  type: "skill.create",
                  name: v.name ?? "",
                  content: v.content ?? "",
                }),
              })
            }
          />
          {data?.skills.map((item) => (
            <View key={item.name} className="gap-2 rounded-xl bg-card p-3">
              <Text>{item.name}</Text>
              <Text>{item.description}</Text>
              <Action
                label="Open skill"
                onPress={() => {
                  setSection("skill");
                  setDetail({ id: item.name });
                }}
              />
              <Action
                label={item.enabled ? "Disable" : "Enable"}
                disabled={busy}
                onPress={() => {
                  void execute({ type: "skill.toggle", name: item.name, enabled: !item.enabled });
                }}
              />
            </View>
          ))}
        </>
      ) : null}
      {section === "skill" ? (
        <>
          <Text selectable>{data?.content}</Text>
          <Action
            label="Edit skill"
            disabled={busy || !data}
            onPress={() =>
              setForm({
                title: "Edit skill",
                values: { content: data?.content ?? "" },
                submit: (v) => ({
                  type: "skill.save",
                  name: detail.id ?? "",
                  content: v.content ?? "",
                }),
              })
            }
          />
        </>
      ) : null}
      {section === "channels"
        ? data?.channels.map((item) => (
            <View key={item.id} className="gap-2 rounded-xl bg-card p-3">
              <Text>
                {item.name} · {item.configured ? "Configured" : "Setup needed"}
              </Text>
              <Text>{item.description}</Text>
              <Action
                label="Configure"
                disabled={busy}
                onPress={() =>
                  setForm({
                    title: item.name,
                    labels: Object.fromEntries(
                      item.fields.map((field) => [field.name, field.label]),
                    ),
                    secrets: item.fields.filter((field) => field.secret).map((field) => field.name),
                    help: "Leave existing values blank to keep them unchanged.",
                    values: Object.fromEntries(item.fields.map((field) => [field.name, ""])),
                    submit: (v) => ({
                      type: "channel.save",
                      id: item.id,
                      enabled: item.enabled,
                      values: Object.fromEntries(
                        Object.entries(v).filter(([, value]) => value.length > 0),
                      ),
                    }),
                  })
                }
              />
              <Action
                label={item.enabled ? "Disable" : "Enable"}
                disabled={busy}
                onPress={() => {
                  void execute({
                    type: "channel.save",
                    id: item.id,
                    enabled: !item.enabled,
                    values: {},
                  });
                }}
              />
            </View>
          ))
        : null}
      {section === "artifacts" ? (
        <>
          {data?.artifacts?.map((artifact) => (
            <View key={artifact.id} className="gap-2 rounded-xl bg-card p-3">
              <Text className="font-t3-semibold">{artifact.label}</Text>
              <Text>{artifact.sessionTitle}</Text>
              {artifact.value.startsWith("data:image/") ? (
                <HermesArtifactPreview content={artifact.value} path={artifact.label} />
              ) : (
                <Action
                  label={/^https?:\/\//iu.test(artifact.value) ? "Open link" : "Preview or save"}
                  onPress={() => {
                    if (/^https?:\/\//iu.test(artifact.value)) {
                      void Linking.openURL(artifact.value).catch((error) =>
                        Alert.alert("Could not open link", String(error)),
                      );
                    } else {
                      setSection("artifact");
                      setDetail({ id: artifact.sessionId, path: artifact.value });
                    }
                  }}
                />
              )}
              <Action
                label="Open originating conversation"
                disabled={busy}
                onPress={() => {
                  void execute({ type: "conversation.open", sessionId: artifact.sessionId });
                }}
              />
            </View>
          ))}
          {data?.artifactsNextOffset !== null && data?.artifactsNextOffset !== undefined ? (
            <Action
              label="More results"
              onPress={() => setDetail({ offset: data.artifactsNextOffset ?? 0 })}
            />
          ) : null}
          {(detail.offset ?? 0) > 0 ? (
            <Action label="Newest results" onPress={() => setDetail({})} />
          ) : null}
        </>
      ) : null}
      {section === "artifact" ? (
        <HermesArtifactPreview content={data?.content ?? null} path={data?.path ?? null} />
      ) : null}
      {section === "files"
        ? data?.files.map((item) => (
            <Action
              key={item.path}
              label={`${item.directory ? "Folder: " : ""}${item.name}`}
              onPress={() => {
                setSection(item.directory ? "files" : "file");
                setDetail({ path: item.path });
              }}
            />
          ))
        : null}
      {section === "status" ? (
        <>
          <Text>Background service: {data?.gatewayState ?? "Unknown"}</Text>
          {data?.gatewayRunning === false ? (
            <Action
              label="Start background service"
              disabled={busy}
              onPress={() => {
                void execute({ type: "gateway.start" });
              }}
            />
          ) : null}
          {data?.gatewayRunning === true ? (
            <Action
              label="Stop background service"
              disabled={busy}
              onPress={() =>
                showConfirmDialog({
                  title: "Stop Hermes background service?",
                  message: "Scheduled tasks will not execute while the service is stopped.",
                  confirmText: "Stop",
                  destructive: true,
                  onConfirm: () => {
                    void execute({ type: "gateway.stop" });
                  },
                })
              }
            />
          ) : null}
        </>
      ) : null}
      {section === "run" || section === "status" ? (
        <Text selectable>{data?.content ?? "No additional detail available."}</Text>
      ) : null}
      {section === "file" ? (
        <Text selectable>{data?.content ?? "This file has no text preview."}</Text>
      ) : null}
      {form ? (
        <WorkForm
          form={form}
          busy={busy}
          onClose={() => setForm(null)}
          onSave={(values) => {
            void execute(form.submit(values));
          }}
        />
      ) : null}
    </View>
  );
}

function WorkForm({
  form,
  busy,
  onClose,
  onSave,
}: {
  form: Form;
  busy: boolean;
  onClose: () => void;
  onSave: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState(form.values);
  useEffect(() => setValues(form.values), [form]);
  return (
    <Modal
      visible
      presentationStyle="pageSheet"
      animationType="slide"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <ScrollView
        contentContainerClassName="gap-4 bg-sheet px-5 pb-10 pt-8"
        keyboardShouldPersistTaps="handled"
      >
        <Text className="text-xl font-t3-semibold">{form.title}</Text>
        {form.help ? <Text>{form.help}</Text> : null}
        {Object.entries(values).map(([key, value]) => (
          <View key={key} className="gap-2">
            {!form.toggles?.[key] ? (
              <Text>
                {key === "schedule"
                  ? "Schedule (0 * * * * runs every hour)"
                  : (form.labels?.[key] ??
                    (key === "deliver"
                      ? "Delivery destination"
                      : key === "prompt"
                        ? "Instructions"
                        : key.charAt(0).toUpperCase() + key.slice(1)))}
              </Text>
            ) : null}
            {key === "schedule" ? (
              <View className="flex-row gap-2">
                <Action
                  label="Every hour"
                  disabled={busy}
                  onPress={() => setValues((current) => ({ ...current, schedule: "0 * * * *" }))}
                />
                <Action
                  label="Daily at 09:00"
                  disabled={busy}
                  onPress={() => setValues((current) => ({ ...current, schedule: "0 9 * * *" }))}
                />
              </View>
            ) : null}
            {form.toggles?.[key] ? (
              <View className="flex-row items-center justify-between gap-3">
                <Text className="flex-1">{form.toggles[key]}</Text>
                <ThemedSwitch
                  accessibilityLabel={form.toggles[key]}
                  disabled={busy}
                  value={value === "true"}
                  onValueChange={(enabled) =>
                    setValues((current) => ({ ...current, [key]: String(enabled) }))
                  }
                />
              </View>
            ) : (
              <TextInput
                accessibilityLabel={key}
                value={value}
                editable={!busy}
                autoCapitalize="none"
                secureTextEntry={form.secrets?.includes(key) ?? false}
                multiline={key === "content" || key === "prompt" || key === "description"}
                className="rounded-xl border border-secondary-border p-3 text-foreground"
                onChangeText={(text) => setValues((current) => ({ ...current, [key]: text }))}
              />
            )}
          </View>
        ))}
        <Action label={busy ? "Saving…" : "Save"} disabled={busy} onPress={() => onSave(values)} />
        <Action label="Cancel" disabled={busy} onPress={onClose} />
      </ScrollView>
    </Modal>
  );
}

function EnvironmentWork({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    hermesEnvironment.workConnections({ environmentId, input: {} }),
  );
  return (
    <View className="gap-4">
      {query.error ? <Text className="text-red-500">{query.error}</Text> : null}
      {query.isPending ? <Text>Loading assistants…</Text> : null}
      {query.data?.connections.length === 0 ? (
        <HermesSetupCard environmentId={environmentId} onConnected={query.refresh} />
      ) : null}
      {query.data?.connections.map((connection) => (
        <View key={connection.providerInstanceId} className="gap-3">
          <Text className="text-lg font-t3-semibold">{connection.displayName}</Text>
          <HermesSetupCard
            environmentId={environmentId}
            providerInstanceId={connection.providerInstanceId}
            configured={connection.configured}
            onConnected={query.refresh}
          />
          {connection.configured ? (
            <WorkConnection
              environmentId={environmentId}
              providerInstanceId={connection.providerInstanceId}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}

export function SettingsHermesWorkRouteScreen() {
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  return (
    <View className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="text-sm text-foreground-muted">
          Manage assistants and scheduled work on their hosting environment. Hermes runs schedules
          while its background service is available, including when this app is closed.
        </Text>
        {environments.length === 0 ? <Text>Connect an environment to manage T3 Work.</Text> : null}
        {environments.map((environment) => (
          <View key={environment.environmentId} className="gap-3">
            <Text className="font-t3-semibold">{environment.label}</Text>
            <EnvironmentWork environmentId={environment.environmentId} />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
