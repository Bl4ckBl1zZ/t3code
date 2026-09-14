import type {
  EnvironmentId,
  HermesWorkGroupsMutateInput,
  HermesWorkQueryResult,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { randomUUID } from "../lib/utils";
import { hermesEnvironment } from "../state/hermes";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
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

type Command = HermesWorkGroupsMutateInput["command"];

/** A native Hermes group conversation, including its persistent member roster. */
export function HermesWorkGroups({
  environmentId,
  providerInstanceId,
  profile,
  profiles,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: string;
  readonly profile: string;
  readonly profiles: HermesWorkQueryResult["profiles"];
}) {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"create" | "rename" | "remove" | null>(null);
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const input = { providerInstanceId, profile, ...(roomId ? { roomId, cursor } : { offset }) };
  const query = useEnvironmentQuery(hermesEnvironment.workGroupsQuery({ environmentId, input }));
  const mutate = useAtomCommand(hermesEnvironment.workGroupsMutate, { reportFailure: false });
  const room = query.data?.groups.find((group) => group.id === roomId) ?? null;
  useEffect(() => {
    if (!roomId || query.data?.hasMore) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") query.refresh();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [roomId, query.data?.hasMore, query.refresh]);

  async function execute(command: Command) {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await mutate({
      environmentId,
      input: { providerInstanceId, profile, operationId: randomUUID(), command },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : String(failure));
      }
      return false;
    }
    setNotice(result.value.message);
    query.refresh();
    return true;
  }

  async function saveDialog() {
    let command: Command;
    if (dialog === "create") {
      const usedHandles = new Set<string>();
      command = {
        type: "create",
        roomId: randomUUID(),
        name: name.trim(),
        members: members.map((member) => {
          const base = member.replace(/[^a-zA-Z0-9_-]/g, "_") || "member";
          let handle = base;
          let suffix = 2;
          while (usedHandles.has(handle.toLowerCase())) handle = `${base}_${suffix++}`;
          usedHandles.add(handle.toLowerCase());
          return { id: randomUUID(), profile: member, handle, name: member };
        }),
      };
    } else if (dialog === "rename" && roomId) {
      command = { type: "rename", roomId, eventId: randomUUID(), name: name.trim() };
    } else if (dialog === "remove" && roomId) {
      command = { type: "remove", roomId };
    } else return;
    if (await execute(command)) {
      setDialog(null);
      if (command.type === "remove") {
        setRoomId(null);
        setCursor(0);
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{room?.name ?? "Assistant groups"}</h3>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => query.refresh()}
            disabled={query.isPending}
          >
            Refresh
          </Button>
          {roomId ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setRoomId(null);
                setCursor(0);
              }}
            >
              All groups
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={profiles.length < 2}
              onClick={() => {
                setName("");
                setMembers([]);
                setDialog("create");
              }}
            >
              New group
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Bring two to six assistants into a shared conversation. Mention an assistant by its @handle
        to direct a message.
      </p>
      {error || query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? query.error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {query.isPending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading group activity…
        </p>
      ) : null}
      {!roomId ? (
        <>
          {query.data?.groups.map((group) => (
            <button
              key={group.id}
              type="button"
              className="block w-full space-y-2 rounded-lg border border-border p-4 text-left hover:bg-muted/50"
              onClick={() => {
                setRoomId(group.id);
                setCursor(0);
              }}
            >
              <span className="block text-sm font-medium">
                {group.name}
                {group.disbandedAt ? " · Disbanded" : ""}
              </span>
              <span className="block text-xs text-muted-foreground">
                {group.members.map((member) => `@${member.handle}`).join(", ")}
              </span>
            </button>
          ))}
          {query.data?.groups.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No assistant groups yet.</p>
          ) : null}
          <div className="flex gap-2">
            {offset > 0 ? (
              <Button size="xs" variant="outline" onClick={() => setOffset(0)}>
                First page
              </Button>
            ) : null}
            {query.data?.nextOffset !== null && query.data?.nextOffset !== undefined ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => setOffset(query.data?.nextOffset ?? 0)}
              >
                More groups
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          {room ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{room.members.map((member) => `@${member.handle}`).join(" · ")}</span>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || room.disbandedAt !== null}
                onClick={() => {
                  setName(room.name);
                  setDialog("rename");
                }}
              >
                Rename
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || room.disbandedAt !== null}
                onClick={() => void execute({ type: "stop", roomId })}
              >
                Stop current work
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || room.disbandedAt !== null}
                onClick={() => setDialog("remove")}
              >
                Disband
              </Button>
            </div>
          ) : null}
          <div className="space-y-3">
            {query.data?.events.map((event) => (
              <article key={event.id} className="rounded-lg border border-border p-4">
                <div className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {event.actor || "System"} · {event.kind.replaceAll("_", " ")}
                  </span>
                  <time>{new Date(event.createdAt * 1000).toLocaleString()}</time>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">{event.text}</p>
              </article>
            ))}
          </div>
          <div className="flex gap-2">
            {cursor > 0 ? (
              <Button size="xs" variant="outline" onClick={() => setCursor(0)}>
                Beginning
              </Button>
            ) : null}
            {query.data?.hasMore ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => setCursor(query.data?.cursor ?? 0)}
              >
                Next messages
              </Button>
            ) : null}
          </div>
          {room?.disbandedAt === null ? (
            <div className="space-y-2">
              <Textarea
                rows={3}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Ask your assistants to collaborate…"
                aria-label="Group message"
              />
              <Button
                size="sm"
                disabled={busy || !text.trim()}
                onClick={() => {
                  void execute({
                    type: "send",
                    roomId,
                    eventId: randomUUID(),
                    threadId: randomUUID(),
                    text: text.trim(),
                  }).then((sent) => {
                    if (sent) setText("");
                  });
                }}
              >
                Send message
              </Button>
            </div>
          ) : null}
        </>
      )}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {dialog === "create"
                ? "New assistant group"
                : dialog === "rename"
                  ? "Rename group"
                  : "Disband this group?"}
            </DialogTitle>
            <DialogDescription>
              {dialog === "remove"
                ? "The group will no longer accept new messages. Its existing conversation remains available."
                : "Group members come from the Hermes profiles in this environment."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4 py-4">
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              {dialog !== "remove" ? (
                <label className="block space-y-1 text-sm">
                  <span>Name</span>
                  <Input value={name} onChange={(event) => setName(event.target.value)} />
                </label>
              ) : null}
              {dialog === "create" ? (
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-sm">Choose two to six assistants</legend>
                  {profiles.map((assistant) => (
                    <label key={assistant.name} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={members.includes(assistant.name)}
                        disabled={!members.includes(assistant.name) && members.length >= 6}
                        onChange={(event) =>
                          setMembers((current) =>
                            event.target.checked
                              ? [...current, assistant.name]
                              : current.filter((member) => member !== assistant.name),
                          )
                        }
                      />
                      {assistant.name}
                    </label>
                  ))}
                </fieldset>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button size="sm" variant="outline" disabled={busy} />}>
              Cancel
            </DialogClose>
            <Button
              size="sm"
              variant={dialog === "remove" ? "destructive" : "default"}
              disabled={
                busy ||
                (dialog !== "remove" && !name.trim()) ||
                (dialog === "create" && members.length < 2)
              }
              onClick={() => void saveDialog()}
            >
              {busy ? "Saving…" : dialog === "remove" ? "Disband" : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
