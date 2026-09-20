import { waitForThreadShell } from "../state/entities";
import { HermesSetup } from "./HermesSetup";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, hermesWorkScheduleStatus } from "@t3tools/contracts";
import { buildThreadRouteParams } from "../threadRoutes";
import { HermesWorkGroups } from "./HermesWorkGroups";
import type {
  HermesWorkCommand,
  HermesWorkQueryInput,
  HermesWorkQueryResult,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState, type ReactNode } from "react";
import { RefreshCwIcon, PlusIcon } from "lucide-react";

import { useHermesConnection } from "../hooks/useHermesConnection";
import { useHermesProfile } from "../hooks/useHermesProfile";
import { useWorkEnvironment } from "../hooks/useWorkEnvironment";
import { hermesEnvironment } from "../state/hermes";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

type Section =
  | "artifacts"
  | "automation"
  | "groups"
  | "sessions"
  | "status"
  | "profiles"
  | "schedules"
  | "runs"
  | "instructions"
  | "memory"
  | "skills"
  | "channels"
  | "files";
const SECTIONS: ReadonlyArray<{ id: Section; label: string }> = [
  { id: "profiles", label: "Assistants" },
  { id: "sessions", label: "Conversations" },
  { id: "groups", label: "Groups" },
  { id: "status", label: "Service status" },
  { id: "schedules", label: "Scheduled tasks" },
  { id: "automation", label: "Automation settings" },
  { id: "runs", label: "Run history" },
  { id: "instructions", label: "Instructions" },
  { id: "memory", label: "Memory" },
  { id: "skills", label: "Skills" },
  { id: "channels", label: "Messaging" },
  { id: "artifacts", label: "Generated results" },
  { id: "files", label: "Files" },
];
/** A finished task reads as finished; only a waiting one keeps the live badge. */
const scheduleBadge = {
  scheduled: { label: "Scheduled", variant: "success" },
  paused: { label: "Paused", variant: "outline" },
  completed: { label: "Completed", variant: "secondary" },
  error: { label: "Failed", variant: "error" },
} as const;
type Schedule = HermesWorkQueryResult["schedules"][number];
type Profile = HermesWorkQueryResult["profiles"][number];
type Channel = HermesWorkQueryResult["channels"][number];
type Editor =
  | { kind: "automation"; timezone: string; allowAgentScheduling: boolean }
  | { kind: "schedule"; job: Schedule | null }
  | { kind: "profile"; profile: Profile | null }
  | { kind: "profile.rename"; profile: Profile }
  | { kind: "profile.model"; profile: Profile }
  | { kind: "skill"; name: string; content: string }
  | { kind: "channel"; channel: Channel }
  | {
      kind: "text";
      title: string;
      content: string;
      command: "instructions.save" | "memory.save";
      file: "MEMORY.md" | "USER.md";
    }
  | { kind: "remove"; title: string; command: HermesWorkCommand };

/** Native Hermes state is managed through the selected T3 environment. */
export function HermesWorkManager({
  initialSection = "profiles",
}: {
  readonly initialSection?: Section;
}) {
  const environment = useWorkEnvironment();
  return (
    <HermesWorkManagerForEnvironment
      key={environment?.environmentId ?? "none"}
      initialSection={initialSection}
    />
  );
}

function HermesWorkManagerForEnvironment({ initialSection }: { readonly initialSection: Section }) {
  const environment = useWorkEnvironment();
  const navigateTo = useNavigate();
  const [connectionId, setConnectionId] = useHermesConnection(environment?.environmentId ?? null);
  const connections = useEnvironmentQuery(
    environment
      ? hermesEnvironment.workConnections({ environmentId: environment.environmentId, input: {} })
      : null,
  );
  const connection =
    connections.data?.connections.find((item) => item.providerInstanceId === connectionId) ??
    connections.data?.connections[0] ??
    null;
  const [profile, setProfile] = useHermesProfile(
    environment?.environmentId ?? null,
    connection?.providerInstanceId ?? null,
  );
  const [section, setSection] = useState<Section>(initialSection);
  const [artifactOffset, setArtifactOffset] = useState(0);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [memoryFile, setMemoryFile] = useState<"MEMORY.md" | "USER.md">("MEMORY.md");
  const [editorState, setEditorState] = useState<{ editor: Editor; scope: string } | null>(null);
  const editorScope = `${connection?.providerInstanceId ?? "none"}:${profile}`;
  const editor = editorState?.scope === editorScope ? editorState.editor : null;
  const setEditor = (next: Editor | null) =>
    setEditorState(next ? { editor: next, scope: editorScope } : null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inspection, setInspection] = useState<{
    section: "skill" | "file" | "run" | "artifact";
    value: string;
    sessionId?: string;
    label?: string;
  } | null>(null);
  const mutate = useAtomCommand(hermesEnvironment.workMutate, { reportFailure: false });
  const target =
    environment && connection
      ? {
          environmentId: environment.environmentId,
          input: { providerInstanceId: connection.providerInstanceId, profile },
        }
      : null;
  const profiles = useEnvironmentQuery(
    target
      ? hermesEnvironment.workQuery({ ...target, input: { ...target.input, section: "profiles" } })
      : null,
  );
  const queryInput: HermesWorkQueryInput | null = target
    ? {
        ...target.input,
        section: inspection?.section ?? (section === "groups" ? "profiles" : section),
        ...(inspection && inspection.section !== "file"
          ? { id: inspection.sessionId ?? inspection.value }
          : {}),
        ...(inspection?.section === "file" || inspection?.section === "artifact"
          ? { path: inspection.value }
          : {}),
        ...(!inspection && section === "artifacts" ? { offset: artifactOffset } : {}),
        ...(!inspection && section === "files" ? { path } : {}),
        ...(!inspection && section === "runs" && scheduleId ? { id: scheduleId } : {}),
        ...(!inspection && section === "memory" ? { path: memoryFile } : {}),
      }
    : null;
  const query = useEnvironmentQuery(
    target && queryInput
      ? hermesEnvironment.workQuery({ environmentId: target.environmentId, input: queryInput })
      : null,
  );
  const data = query.data;
  useEffect(() => {
    if (!["runs", "schedules", "status", "sessions"].includes(section) || inspection) return;
    const refreshVisible = () => {
      if (document.visibilityState === "visible") query.refresh();
    };
    const interval = window.setInterval(refreshVisible, 15000);
    window.addEventListener("focus", refreshVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshVisible);
    };
  }, [section, inspection, query.refresh]);

  async function execute(command: HermesWorkCommand) {
    if (!target || busy) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await mutate({ ...target, input: { ...target.input, command } });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : String(failure));
      }
      return false;
    }
    setNotice(result.value.message);
    if (command.type === "profile.rename" && profile === command.name) setProfile(command.newName);
    if (command.type === "profile.remove" && profile === command.name) setProfile("default");
    if (result.value.threadId) {
      const threadRef = scopeThreadRef(target.environmentId, ThreadId.make(result.value.threadId));
      if (await waitForThreadShell(threadRef)) {
        void navigateTo({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      } else {
        setNotice(
          "Conversation opened. Waiting for it to sync; select it in the sidebar once it appears.",
        );
      }
    }
    query.refresh();
    profiles.refresh();
    return true;
  }

  function navigate(next: Section) {
    setSection(next);
    if (next !== "runs") setScheduleId(null);
    setInspection(null);
    setError(null);
    setNotice(null);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Your assistants and ongoing work</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {environment?.label ?? "No environment selected"} · Schedules run in Hermes while its
            background service is available.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            connections.refresh();
            profiles.refresh();
            query.refresh();
          }}
          disabled={query.isPending || connections.isPending}
        >
          <RefreshCwIcon className="size-3.5" /> Refresh
        </Button>
      </div>
      {connections.error ? <ErrorMessage>{connections.error}</ErrorMessage> : null}
      {connections.isPending && !connections.data ? (
        <p className="text-sm text-muted-foreground">Connecting to Hermes…</p>
      ) : null}
      {environment ? (
        <HermesSetup
          key={`${environment.environmentId}:${connection?.providerInstanceId ?? "hermes"}`}
          environmentId={environment.environmentId}
          environmentLabel={environment.label}
          providerInstanceId={connection?.providerInstanceId ?? "hermes"}
          onConnected={() => {
            connections.refresh();
            profiles.refresh();
            query.refresh();
          }}
        />
      ) : null}
      {connection ? (
        <>
          <div className="flex flex-wrap gap-3">
            <Field label="Connection">
              <select
                className={SELECT_CLASS}
                disabled={busy}
                value={connection.providerInstanceId}
                onChange={(event) => {
                  setConnectionId(event.target.value);
                  setInspection(null);
                  setPath("");
                  setEditor(null);
                }}
              >
                {connections.data?.connections.map((item) => (
                  <option key={item.providerInstanceId} value={item.providerInstanceId}>
                    {item.displayName}
                    {item.configured ? "" : " · not configured"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Assistant">
              <select
                className={SELECT_CLASS}
                disabled={busy}
                value={profile}
                onChange={(event) => {
                  setProfile(event.target.value);
                  setInspection(null);
                  setPath("");
                  setEditor(null);
                }}
              >
                {!profiles.data?.profiles.some((item) => item.name === profile) ? (
                  <option value={profile}>{profile}</option>
                ) : null}
                {profiles.data?.profiles.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                    {item.isDefault ? " · default" : ""}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <nav
            aria-label="Work management"
            className="flex flex-wrap gap-1 border-b border-border pb-2"
          >
            {SECTIONS.map((item) => (
              <Button
                key={item.id}
                size="sm"
                variant={section === item.id ? "secondary" : "ghost"}
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => navigate(item.id)}
              >
                {item.label}
              </Button>
            ))}
          </nav>
          {error || query.error ? <ErrorMessage>{error ?? query.error}</ErrorMessage> : null}
          {notice ? (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          ) : null}
          {data?.diagnostics.map((diagnostic) => (
            <p key={diagnostic} className="text-xs text-muted-foreground">
              {diagnostic}
            </p>
          ))}
          {query.isPending ? (
            <p role="status" className="text-xs text-muted-foreground">
              Refreshing {SECTIONS.find((item) => item.id === section)?.label.toLowerCase()}…
            </p>
          ) : null}
          {inspection ? (
            <div className="space-y-3">
              <Button size="sm" variant="outline" onClick={() => setInspection(null)}>
                Back to {section}
              </Button>
              <h3 className="font-medium break-all">{inspection.value}</h3>
              {data?.content !== null && data?.content !== undefined ? (
                <>
                  {inspection.section === "artifact" ? (
                    <div className="space-y-3">
                      {/^data:image\/(png|jpeg|gif|webp|avif);/i.test(data.content) ? (
                        <img
                          src={data.content}
                          alt={inspection.label ?? "Generated image"}
                          className="max-h-[60vh] max-w-full rounded-lg object-contain"
                        />
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          Download this file to view it.
                        </p>
                      )}
                      <a
                        href={data.content}
                        download={inspection.label ?? "artifact"}
                        className="inline-block text-sm underline"
                      >
                        Download file
                      </a>
                    </div>
                  ) : (
                    <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border p-4 text-xs">
                      {data.content}
                    </pre>
                  )}
                  {inspection.section === "skill" ? (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        setEditor({
                          kind: "skill",
                          name: inspection.value,
                          content: data.content ?? "",
                        })
                      }
                    >
                      Edit skill
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : data ? (
            <>
              {section === "groups" && target ? (
                <HermesWorkGroups
                  key={`${target.environmentId}:${target.input.providerInstanceId}:${profile}`}
                  environmentId={target.environmentId}
                  providerInstanceId={target.input.providerInstanceId}
                  profile={profile}
                  profiles={profiles.data?.profiles ?? []}
                />
              ) : null}
              {section === "sessions" ? (
                <div className="space-y-3">
                  <SectionHeading
                    title="Conversations"
                    action={
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void execute({ type: "conversation.open", surface: "work" })}
                      >
                        New conversation
                      </Button>
                    }
                  />
                  {data.sessions?.map((session) => (
                    <Card key={session.id} title={session.title} detail={session.preview}>
                      <p className="text-xs text-muted-foreground">
                        {session.active ? "Active" : "Saved"} · {formatTime(session.updatedAt)}
                      </p>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void execute({
                            type: "conversation.open",
                            sessionId: session.id,
                            surface: "work",
                          })
                        }
                      >
                        Open conversation
                      </Button>
                    </Card>
                  ))}
                  <EmptyList empty={!data.sessions?.length}>
                    No conversations are available for this assistant.
                  </EmptyList>
                </div>
              ) : null}
              {section === "status" ? (
                <div className="space-y-3">
                  <SectionHeading title="Background service" />
                  <Badge variant={data.gatewayRunning === true ? "success" : "outline"}>
                    {data.gatewayRunning === true
                      ? "Running"
                      : data.gatewayRunning === false
                        ? "Stopped"
                        : "Status unknown"}
                  </Badge>
                  {data.gatewayState ? (
                    <p className="text-sm text-muted-foreground">{data.gatewayState}</p>
                  ) : null}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || data.gatewayRunning === true}
                      onClick={() => void execute({ type: "gateway.start" })}
                    >
                      Start background service
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || data.gatewayRunning !== true}
                      onClick={() =>
                        setEditor({
                          kind: "remove",
                          title: "Stop the Hermes background service?",
                          command: { type: "gateway.stop" },
                        })
                      }
                    >
                      Stop background service
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Hermes reports its background service separately from conversation connectivity.
                    Refresh to check current availability.
                  </p>
                  {data.content ? (
                    <pre className="whitespace-pre-wrap break-words text-sm">{data.content}</pre>
                  ) : null}
                </div>
              ) : null}
              {section === "profiles" ? (
                <div className="space-y-3">
                  <SectionHeading
                    title="Assistants"
                    action={
                      <Button
                        size="sm"
                        onClick={() => setEditor({ kind: "profile", profile: null })}
                      >
                        <PlusIcon className="size-3.5" /> New assistant
                      </Button>
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Each assistant uses its own Hermes profile, memory, skills, and schedules.
                  </p>
                  {data.profiles.map((item) => (
                    <Card key={item.name} title={item.name} detail={item.description}>
                      <p className="text-xs text-muted-foreground">
                        {item.model || "Default model"}
                        {item.isDefault ? " · Default assistant" : ""}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            setProfile(item.name);
                            navigate("sessions");
                          }}
                        >
                          Conversations
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            setProfile(item.name);
                            navigate("instructions");
                          }}
                        >
                          Instructions
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            setEditor({ kind: "profile", profile: item });
                          }}
                        >
                          Description
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            setEditor({ kind: "profile.model", profile: item });
                          }}
                        >
                          Model
                        </Button>
                        {!item.isDefault ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={busy}
                            onClick={() => {
                              setEditor({ kind: "profile.rename", profile: item });
                            }}
                          >
                            Rename
                          </Button>
                        ) : null}
                        {!item.isDefault ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              setEditor({
                                kind: "remove",
                                title: `Remove assistant ${item.name}?`,
                                command: { type: "profile.remove", name: item.name },
                              })
                            }
                          >
                            Remove
                          </Button>
                        ) : null}
                      </div>
                    </Card>
                  ))}
                  <EmptyList empty={data.profiles.length === 0}>
                    No assistants were reported by Hermes.
                  </EmptyList>
                </div>
              ) : null}
              {section === "automation" ? (
                <div className="space-y-3">
                  <SectionHeading
                    title="Automation settings"
                    action={
                      <Button
                        size="sm"
                        disabled={!data.automation || busy}
                        onClick={() => {
                          if (data.automation)
                            setEditor({ kind: "automation", ...data.automation });
                        }}
                      >
                        Edit settings
                      </Button>
                    }
                  />
                  <p className="text-sm text-muted-foreground">
                    Timezone: {data.automation?.timezone || "Hosting machine default"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Assistant-managed scheduling:{" "}
                    {data.automation?.allowAgentScheduling ? "Enabled" : "Disabled"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    When enabled, scheduled assistants can create, edit, or remove schedules in this
                    profile. These jobs appear alongside your other tasks.
                  </p>
                </div>
              ) : null}
              {section === "schedules" ? (
                <div className="space-y-3">
                  <SectionHeading
                    title="Scheduled tasks"
                    action={
                      <Button size="sm" onClick={() => setEditor({ kind: "schedule", job: null })}>
                        <PlusIcon className="size-3.5" /> New task
                      </Button>
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Manage the same schedules used by Hermes. Pausing prevents future runs; it does
                    not stop work already running.
                  </p>
                  {data.schedules.map((job) => (
                    <Card key={job.id} title={job.name || job.id} detail={job.prompt}>
                      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <Badge variant={scheduleBadge[hermesWorkScheduleStatus(job)].variant}>
                          {scheduleBadge[hermesWorkScheduleStatus(job)].label}
                        </Badge>
                        <span>{job.scheduleDisplay ?? job.schedule}</span>
                        <span>Deliver to {job.deliver || "local results"}</span>
                        {job.model ? <span>Model: {job.model}</span> : null}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Next: {formatTime(job.nextRunAt)} · Last: {formatTime(job.lastRunAt)}
                        {job.lastStatus ? ` · ${job.lastStatus}` : ""}
                      </p>
                      {job.lastError ? <ErrorMessage>{job.lastError}</ErrorMessage> : null}
                      {job.lastDeliveryError ? (
                        <ErrorMessage>Delivery: {job.lastDeliveryError}</ErrorMessage>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setEditor({ kind: "schedule", job })}
                        >
                          Edit
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void execute({
                              type: job.paused ? "schedule.resume" : "schedule.pause",
                              id: job.id,
                            })
                          }
                        >
                          {job.paused ? "Resume" : "Pause"}
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void execute({ type: "schedule.run", id: job.id })}
                        >
                          Run now
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => {
                            navigate("runs");
                            setScheduleId(job.id);
                          }}
                        >
                          Run history
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            setEditor({
                              kind: "remove",
                              title: `Remove scheduled task ${job.name || job.id}?`,
                              command: { type: "schedule.remove", id: job.id },
                            })
                          }
                        >
                          Remove
                        </Button>
                      </div>
                    </Card>
                  ))}
                  <EmptyList empty={data.schedules.length === 0}>
                    No scheduled tasks. Create an hourly check, a daily briefing, or a one-time
                    reminder.
                  </EmptyList>
                </div>
              ) : null}
              {section === "runs" ? (
                <div className="space-y-3">
                  <SectionHeading
                    title="Run history"
                    action={
                      scheduleId ? (
                        <Button size="xs" variant="outline" onClick={() => setScheduleId(null)}>
                          Show all runs
                        </Button>
                      ) : undefined
                    }
                  />
                  {data.runs.map((run) => (
                    <Card key={run.id} title={run.title || run.id}>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant={run.active ? "success" : "outline"}>
                          {run.status ?? (run.active ? "Active" : "Outcome unknown")}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatTime(run.startedAt)}
                          {run.endedAt ? ` → ${formatTime(run.endedAt)}` : ""}
                        </span>
                      </div>
                      {run.readAt === null ? <Badge variant="outline">Unread</Badge> : null}
                      {run.content ? (
                        <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">
                          {run.content}
                        </p>
                      ) : null}
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setInspection({ section: "run", value: run.id })}
                      >
                        View output
                      </Button>
                    </Card>
                  ))}
                  <EmptyList empty={data.runs.length === 0}>
                    No run history is available for this assistant.
                  </EmptyList>
                </div>
              ) : null}
              {section === "instructions" || section === "memory" ? (
                <div className="space-y-3">
                  <SectionHeading
                    title={
                      section === "instructions" ? "Assistant instructions" : "Assistant memory"
                    }
                    action={
                      <Button
                        size="sm"
                        disabled={data.content === null || busy}
                        onClick={() =>
                          setEditor({
                            kind: "text",
                            title:
                              section === "instructions"
                                ? "Edit instructions"
                                : `Edit ${memoryFile}`,
                            content: data.content ?? "",
                            command:
                              section === "instructions" ? "instructions.save" : "memory.save",
                            file: memoryFile,
                          })
                        }
                      >
                        Edit
                      </Button>
                    }
                  />
                  {section === "memory" ? (
                    <div className="flex gap-2">
                      {(["MEMORY.md", "USER.md"] as const).map((file) => (
                        <Button
                          key={file}
                          size="xs"
                          variant={memoryFile === file ? "secondary" : "outline"}
                          onClick={() => setMemoryFile(file)}
                        >
                          {file === "MEMORY.md" ? "Memory" : "About you"}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                  <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border p-4 text-sm">
                    {data.content ?? "No content is available."}
                  </pre>
                </div>
              ) : null}
              {section === "skills" ? (
                <div className="space-y-3">
                  <SectionHeading
                    title="Skills"
                    action={
                      <Button
                        size="sm"
                        onClick={() => setEditor({ kind: "skill", name: "", content: "" })}
                      >
                        <PlusIcon className="size-3.5" /> New skill
                      </Button>
                    }
                  />
                  {data.skills.map((skill) => (
                    <Card key={skill.name} title={skill.name} detail={skill.description}>
                      <div className="flex gap-2">
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => setInspection({ section: "skill", value: skill.name })}
                        >
                          Open
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void execute({
                              type: "skill.toggle",
                              name: skill.name,
                              enabled: !skill.enabled,
                            })
                          }
                        >
                          {skill.enabled ? "Disable" : "Enable"}
                        </Button>
                      </div>
                    </Card>
                  ))}
                  <EmptyList empty={data.skills.length === 0}>
                    No skills were reported for this assistant.
                  </EmptyList>
                </div>
              ) : null}
              {section === "channels" ? (
                <div className="space-y-3">
                  <SectionHeading title="Messaging" />
                  <p className="text-xs text-muted-foreground">
                    Configure where your assistant can receive messages and deliver results.
                  </p>
                  {data.channels.map((channel) => (
                    <Card key={channel.id} title={channel.name} detail={channel.description}>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={channel.enabled && channel.configured ? "success" : "outline"}
                        >
                          {channel.enabled
                            ? channel.configured
                              ? "Configured"
                              : "Needs setup"
                            : "Disabled"}
                        </Badge>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setEditor({ kind: "channel", channel })}
                        >
                          Configure
                        </Button>
                      </div>
                    </Card>
                  ))}
                  <EmptyList empty={data.channels.length === 0}>
                    No messaging channels were reported by Hermes.
                  </EmptyList>
                </div>
              ) : null}
              {section === "artifacts" ? (
                <div className="space-y-3">
                  <SectionHeading title="Generated results" />
                  <p className="text-xs text-muted-foreground">
                    Files, images, and links produced by this assistant, with their originating
                    conversations.
                  </p>
                  {data.artifacts?.map((artifact) => (
                    <Card key={artifact.id} title={artifact.label} detail={artifact.sessionTitle}>
                      <p className="text-xs text-muted-foreground">
                        {artifact.kind} · {formatTime(artifact.timestamp)}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {/^https?:\/\//i.test(artifact.value) ? (
                          <a
                            href={artifact.value}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs underline"
                          >
                            Open link
                          </a>
                        ) : /^data:image\/(png|jpeg|gif|webp|avif);/i.test(artifact.value) ? (
                          <a
                            href={artifact.value}
                            download={artifact.label}
                            className="text-xs underline"
                          >
                            Download image
                          </a>
                        ) : (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() =>
                              setInspection({
                                section: "artifact",
                                value: artifact.value,
                                sessionId: artifact.sessionId,
                                label: artifact.label,
                              })
                            }
                          >
                            Preview or download
                          </Button>
                        )}
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void execute({
                              type: "conversation.open",
                              sessionId: artifact.sessionId,
                              surface: "work",
                            })
                          }
                        >
                          Open conversation
                        </Button>
                      </div>
                    </Card>
                  ))}
                  <EmptyList empty={!data.artifacts?.length}>
                    No generated results were found on this page.
                  </EmptyList>
                  <div className="flex gap-2">
                    {artifactOffset > 0 ? (
                      <Button size="xs" variant="outline" onClick={() => setArtifactOffset(0)}>
                        Newest results
                      </Button>
                    ) : null}
                    {data.artifactsNextOffset !== null && data.artifactsNextOffset !== undefined ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setArtifactOffset(data.artifactsNextOffset ?? 0)}
                      >
                        Older results
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {section === "files" ? (
                <div className="space-y-3">
                  <SectionHeading
                    title="Files and artifacts"
                    action={
                      path ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}
                        >
                          Up one folder
                        </Button>
                      ) : undefined
                    }
                  />
                  <p className="break-all text-xs text-muted-foreground">
                    {data.path || "Assistant files"}
                  </p>
                  <div className="divide-y divide-border rounded-lg border border-border">
                    {data.files.map((file) => (
                      <button
                        type="button"
                        key={file.path}
                        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm hover:bg-muted/50"
                        onClick={() =>
                          file.directory
                            ? setPath(file.path)
                            : setInspection({ section: "file", value: file.path })
                        }
                      >
                        <span className="min-w-0 break-all">
                          {file.directory ? "Folder: " : ""}
                          {file.name}
                        </span>
                        {file.size !== null ? (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {file.size.toLocaleString()} bytes
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                  <EmptyList empty={data.files.length === 0}>This folder is empty.</EmptyList>
                </div>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setEditor(null);
        }}
      >
        {editor ? (
          <WorkEditor
            key={JSON.stringify(editor)}
            editor={editor}
            busy={busy}
            error={error}
            onSubmit={async (command) => {
              if (await execute(command)) setEditor(null);
            }}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

const SELECT_CLASS = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";
function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="block space-y-1.5 text-xs font-medium">
      <span>{label}</span>
      {children}
    </label>
  );
}
function ErrorMessage({ children }: { readonly children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}
function SectionHeading({
  title,
  action,
}: {
  readonly title: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-medium">{title}</h3>
      {action}
    </div>
  );
}
function EmptyList({ empty, children }: { readonly empty: boolean; readonly children: ReactNode }) {
  return empty ? <p className="py-5 text-sm text-muted-foreground">{children}</p> : null;
}
function Card({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <h4 className="break-words text-sm font-medium">{title}</h4>
      {detail ? (
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{detail}</p>
      ) : null}
      {children}
    </section>
  );
}
function formatTime(value: string | number | null) {
  if (value === null) return "Not reported";
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function WorkEditor({
  editor,
  busy,
  error,
  onSubmit,
}: {
  readonly editor: Editor;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSubmit: (command: HermesWorkCommand) => Promise<void>;
}) {
  const [name, setName] = useState(
    editor.kind === "schedule"
      ? (editor.job?.name ?? "")
      : editor.kind === "profile" ||
          editor.kind === "profile.rename" ||
          editor.kind === "profile.model"
        ? (editor.profile?.name ?? "")
        : editor.kind === "skill"
          ? editor.name
          : "",
  );
  const [description, setDescription] = useState(
    editor.kind === "profile" ? (editor.profile?.description ?? "") : "",
  );
  const [content, setContent] = useState(
    editor.kind === "text" || editor.kind === "skill"
      ? editor.content
      : editor.kind === "schedule"
        ? (editor.job?.prompt ?? "")
        : "",
  );
  const [schedule, setSchedule] = useState(
    editor.kind === "schedule" ? (editor.job?.schedule ?? "every 1h") : "",
  );
  const [deliver, setDeliver] = useState(
    editor.kind === "schedule" ? (editor.job?.deliver ?? "local") : "local",
  );
  const [model, setModel] = useState(
    editor.kind === "schedule"
      ? (editor.job?.model ?? "")
      : editor.kind === "profile" || editor.kind === "profile.model"
        ? (editor.profile?.model ?? "")
        : "",
  );
  const [timezone, setTimezone] = useState(editor.kind === "automation" ? editor.timezone : "");
  const [allowAgentScheduling, setAllowAgentScheduling] = useState(
    editor.kind === "automation" ? editor.allowAgentScheduling : false,
  );
  const [continuity, setContinuity] = useState(
    editor.kind === "schedule" ? (editor.job?.continuity ?? false) : false,
  );
  const [provider, setProvider] = useState("");
  const [enabled, setEnabled] = useState(editor.kind === "channel" ? editor.channel.enabled : true);
  const [values, setValues] = useState<Record<string, string>>({});
  const title =
    editor.kind === "automation"
      ? "Automation settings"
      : editor.kind === "schedule"
        ? editor.job
          ? "Edit scheduled task"
          : "New scheduled task"
        : editor.kind === "profile"
          ? editor.profile
            ? "Edit assistant"
            : "New assistant"
          : editor.kind === "skill"
            ? editor.name
              ? "Edit skill"
              : "New skill"
            : editor.kind === "channel"
              ? `Configure ${editor.channel.name}`
              : editor.kind === "profile.rename"
                ? "Rename assistant"
                : editor.kind === "profile.model"
                  ? "Change assistant model"
                  : editor.title;
  const valid =
    editor.kind === "schedule"
      ? name.trim() && content.trim() && schedule.trim()
      : editor.kind === "profile" || editor.kind === "skill" || editor.kind === "profile.rename"
        ? name.trim()
        : editor.kind === "profile.model"
          ? model.trim() && provider.trim()
          : true;
  async function submit() {
    if (!valid || busy) return;
    switch (editor.kind) {
      case "automation":
        return onSubmit({
          type: "automation.save",
          timezone: timezone.trim(),
          allowAgentScheduling,
        });
      case "remove":
        return onSubmit(editor.command);
      case "schedule": {
        const fields = {
          name: name.trim(),
          prompt: content,
          schedule: schedule.trim(),
          deliver: deliver.trim(),
          continuity,
          ...(model.trim() ? { model: model.trim() } : {}),
        };
        return onSubmit(
          editor.job
            ? { type: "schedule.update", id: editor.job.id, ...fields }
            : { type: "schedule.create", ...fields },
        );
      }
      case "profile.rename":
        return onSubmit({
          type: "profile.rename",
          name: editor.profile.name,
          newName: name.trim(),
        });
      case "profile.model":
        return onSubmit({
          type: "profile.model",
          name: editor.profile.name,
          model: model.trim(),
          provider: provider.trim(),
        });
      case "profile":
        return onSubmit(
          editor.profile
            ? { type: "profile.describe", name: editor.profile.name, description }
            : {
                type: "profile.create",
                name: name.trim(),
                description,
                ...(model.trim() ? { model: model.trim() } : {}),
              },
        );
      case "skill":
        return onSubmit({
          type: editor.name ? "skill.save" : "skill.create",
          name: name.trim(),
          content,
        });
      case "text":
        return onSubmit(
          editor.command === "memory.save"
            ? { type: "memory.save", file: editor.file, content, expectedContent: editor.content }
            : { type: "instructions.save", content },
        );
      case "channel":
        return onSubmit({ type: "channel.save", id: editor.channel.id, enabled, values });
    }
  }
  return (
    <DialogPopup className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {editor.kind === "remove"
            ? "This changes the underlying Hermes configuration. Other Hermes clients will see the change."
            : "Changes are saved to this assistant in Hermes."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-4 py-4">
          {error ? <ErrorMessage>{error}</ErrorMessage> : null}
          {editor.kind === "schedule" ||
          editor.kind === "profile" ||
          editor.kind === "skill" ||
          editor.kind === "profile.rename" ? (
            <Field label="Name">
              <Input
                value={name}
                disabled={
                  (editor.kind === "profile" && editor.profile !== null) ||
                  (editor.kind === "skill" && editor.name !== "")
                }
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          ) : null}
          {editor.kind === "automation" ? (
            <>
              <Field label="Timezone">
                <Input
                  value={timezone}
                  placeholder="Europe/Luxembourg (blank uses the hosting machine)"
                  onChange={(event) => setTimezone(event.target.value)}
                />
              </Field>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allowAgentScheduling}
                  onChange={(event) => setAllowAgentScheduling(event.target.checked)}
                />
                <span>
                  Allow scheduled assistants to create, edit, and remove schedules in this profile
                </span>
              </label>
            </>
          ) : null}
          {editor.kind === "profile.model" ? (
            <>
              <Field label="Provider">
                <Input value={provider} onChange={(event) => setProvider(event.target.value)} />
              </Field>
              <Field label="Model">
                <Input value={model} onChange={(event) => setModel(event.target.value)} />
              </Field>
            </>
          ) : null}
          {editor.kind === "schedule" ? (
            <>
              <Field label="When">
                <select
                  className={SELECT_CLASS}
                  value={["every 1h", "0 9 * * *"].includes(schedule) ? schedule : "custom"}
                  onChange={(event) =>
                    setSchedule(event.target.value === "custom" ? "" : event.target.value)
                  }
                >
                  <option value="every 1h">Every hour</option>
                  <option value="0 9 * * *">Every day at 9:00</option>
                  <option value="custom">Custom or one-time</option>
                </select>
              </Field>
              <Field label="Schedule">
                <Input
                  value={schedule}
                  placeholder="every 1h, 0 9 * * *, or a one-time date"
                  onChange={(event) => setSchedule(event.target.value)}
                />
              </Field>
              <p className="text-xs text-muted-foreground">
                Start with <code>every</code> to repeat, as in <code>every 10m</code> or{" "}
                <code>every 1h</code>. A bare duration such as <code>30m</code> runs once and stops.
                Timing follows the Hermes environment’s timezone. Review it before saving a daily
                routine.
              </p>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={continuity}
                  onChange={(event) => setContinuity(event.target.checked)}
                />
                <span>Carry the previous result into the next run</span>
              </label>
              <Field label="Deliver results to">
                <Input
                  value={deliver}
                  placeholder="local"
                  onChange={(event) => setDeliver(event.target.value)}
                />
              </Field>
              <p className="text-xs text-muted-foreground">
                Local results stay in run history. Each run is its own Hermes conversation, so it
                does not reply in the chat that created it. Name a messaging destination to be
                notified elsewhere.
              </p>
              <Field label="Model (optional)">
                <Input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="Assistant default"
                />
              </Field>
            </>
          ) : null}
          {editor.kind === "profile" ? (
            <>
              <Field label="Description">
                <Textarea
                  rows={4}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
              {!editor.profile ? (
                <Field label="Model (optional)">
                  <Input value={model} onChange={(event) => setModel(event.target.value)} />
                </Field>
              ) : null}
            </>
          ) : null}
          {editor.kind === "text" || editor.kind === "skill" || editor.kind === "schedule" ? (
            <Field label={editor.kind === "schedule" ? "What should the assistant do?" : "Content"}>
              <Textarea
                rows={editor.kind === "schedule" ? 5 : 14}
                value={content}
                onChange={(event) => setContent(event.target.value)}
              />
            </Field>
          ) : null}
          {editor.kind === "channel" ? (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />{" "}
                Enable this channel
              </label>
              {editor.channel.fields.map((field) => (
                <Field key={field.name} label={field.label}>
                  <Input
                    type={field.secret ? "password" : "text"}
                    autoComplete="off"
                    value={values[field.name] ?? ""}
                    placeholder={
                      field.configured ? "Configured · leave empty to keep" : "Not configured"
                    }
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.name]: event.target.value }))
                    }
                  />
                </Field>
              ))}
            </>
          ) : null}
          {editor.kind === "remove" ? (
            <p className="text-sm text-muted-foreground">
              {editor.command.type === "gateway.stop"
                ? "Scheduled tasks and messaging will be unavailable while the service is stopped. You can start it again here."
                : editor.command.type === "schedule.remove"
                  ? "Future runs will no longer be scheduled. Removing a schedule does not stop a run already in progress."
                  : "Removing a profile affects its Hermes assistant data. Choose Cancel to keep it."}
            </p>
          ) : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" size="sm" disabled={busy} />}>
          Cancel
        </DialogClose>
        <Button
          size="sm"
          variant={editor.kind === "remove" ? "destructive" : "default"}
          disabled={busy || !valid}
          onClick={() => void submit()}
        >
          {busy
            ? "Applying…"
            : editor.kind === "remove"
              ? editor.command.type === "gateway.stop"
                ? "Stop service"
                : "Remove"
              : "Save in Hermes"}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
