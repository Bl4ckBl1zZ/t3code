import { UsageLimitSourceId, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { randomUUID } from "../../lib/utils";
import { useRef, useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** Hub credentials and settings belong to this environment only. */
export function UsageLimitSources({
  environmentId,
  label,
  config,
  canOperate,
}: {
  environmentId: EnvironmentId;
  label: string;
  config: ServerConfig;
  canOperate: boolean;
}) {
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [editing, setEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const save: typeof update = async (input) => {
    setBusy(true);
    setError(null);
    try {
      const result = await update(input);
      if (result._tag === "Failure")
        setError("Could not save hub settings. Your changes have not been saved.");
      return result;
    } finally {
      setBusy(false);
    }
  };
  const sources = config.settings?.usageLimitSources ?? {};
  return (
    <section className="mb-4 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{label} · Quota hubs</h2>
        <Button
          size="xs"
          variant="outline"
          disabled={!canOperate || busy}
          onClick={() => {
            setEditing(!editing);
            setEditingId(null);
            setUrl("");
            setName("");
            setKey("");
          }}
        >
          {editing ? "Cancel" : "Add hub"}
        </Button>
      </div>
      {Object.entries(sources).map(([id, source]) => {
        const snapshot = config.usageLimitSources?.find((entry) => entry.id === id);
        return (
          <div key={id} className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 break-all">
              {source.label || source.url}
              {!source.enabled
                ? " · Disabled"
                : snapshot?.error
                  ? ` · ${snapshot.error}`
                  : ` · ${snapshot?.accounts.length ?? 0} accounts`}
            </span>
            <Button
              size="xs"
              variant="ghost"
              disabled={!canOperate || busy || editing}
              onClick={() => {
                setEditingId(id);
                setUrl(source.url);
                setName(source.label ?? "");
                setKey("");
                setEditing(true);
              }}
            >
              Edit
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!canOperate || busy}
              onClick={() =>
                void save({
                  environmentId,
                  input: {
                    patch: { usageLimitSources: { [id]: { ...source, enabled: !source.enabled } } },
                  },
                })
              }
            >
              {source.enabled ? "Disable" : "Enable"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!canOperate || busy}
              onClick={() =>
                void save({
                  environmentId,
                  input: { patch: { usageLimitSources: { [id]: null } } },
                })
              }
            >
              Remove
            </Button>
          </div>
        );
      })}
      {editing && (
        <form
          className="mt-4 grid gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (inFlight.current || !canOperate) return;
            let parsed: URL;
            try {
              parsed = new URL(url.trim());
              if (
                !["http:", "https:"].includes(parsed.protocol) ||
                parsed.username ||
                parsed.password
              )
                throw new Error();
            } catch {
              setError("Enter an HTTP or HTTPS hub URL without embedded credentials.");
              return;
            }
            if (!key.trim() && editingId === null) {
              setError("Enter a management key.");
              return;
            }
            inFlight.current = true;
            try {
              const result = await save({
                environmentId,
                input: {
                  patch: {
                    usageLimitSources: {
                      [UsageLimitSourceId.make(editingId ?? `cliproxy-${randomUUID()}`)]: {
                        kind: "cliproxy",
                        url: parsed.href,
                        managementKey:
                          key.trim() ||
                          (editingId
                            ? (sources[UsageLimitSourceId.make(editingId)]?.managementKey ?? "")
                            : ""),
                        enabled: editingId
                          ? (sources[UsageLimitSourceId.make(editingId)]?.enabled ?? true)
                          : true,
                        ...(name.trim() ? { label: name.trim() } : {}),
                      },
                    },
                  },
                },
              });
              if (result._tag === "Success") {
                setEditing(false);
                setUrl("");
                setName("");
                setKey("");
              }
            } finally {
              inFlight.current = false;
            }
          }}
        >
          <label className="grid gap-1 text-xs">
            Hub URL
            <Input
              type="url"
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://hub.example.com:8318"
            />
          </label>
          <label className="grid gap-1 text-xs">
            Management key
            <Input
              type="password"
              autoComplete="off"
              placeholder={editingId ? "Blank keeps the current key" : undefined}
              required={editingId === null}
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs">
            Label (optional)
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <p className="text-xs text-muted-foreground">
            The key stays in this server’s secret store. Hub accounts report quota; they do not run
            tasks.
          </p>
          <Button type="submit" disabled={busy || !canOperate}>
            {busy ? "Saving…" : "Save hub"}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
