import { readHermesWorkGateway } from "./HermesWorkGateway.ts";
import {
  decodeHermesWorkAutomation,
  hermesWorkAutomationPatch,
  hermesWorkContinuitySources,
} from "./HermesWorkAutomation.ts";
import {
  HermesWorkError,
  type HermesWorkQueryInput,
  type HermesWorkQueryResult,
  type HermesWorkMutateInput,
} from "@t3tools/contracts";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { queryHermesWorkArtifacts } from "./HermesWorkArtifacts.ts";
import { HermesWorkRunRepository } from "./HermesWorkRunRepository.ts";
import { HermesWorkConversationService } from "./HermesWorkConversationService.ts";
import { HermesDashboardClient, type HermesDashboardRequest } from "./HermesDashboardClient.ts";

const Text = Schema.NullOr(Schema.String);
const Row = Schema.Record(Schema.String, Schema.Unknown);
const Rows = Schema.Array(Row);
const isText = Schema.is(Schema.String);
const isNumber = Schema.is(Schema.Number);
const isRow = Schema.is(Row);
const isRows = Schema.is(Rows);
const isWorkError = Schema.is(HermesWorkError);
const decodeSavedMessages = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ messages: Rows })),
);
const text = (value: unknown) => (isText(value) ? value : "");
const nullableText = (value: unknown) => text(value) || null;
const flag = (value: unknown) => value === true;
const number = (value: unknown) => (isNumber(value) ? value : null);
const nested = (value: unknown) => (isRow(value) ? value : {});
const rows = (value: unknown) => (isRows(value) ? value : []);
const empty = (): HermesWorkQueryResult => ({
  gatewayRunning: null,
  gatewayState: null,
  profiles: [],
  schedules: [],
  runs: [],
  skills: [],
  channels: [],
  files: [],
  content: null,
  path: null,
  diagnostics: [],
});

/** Hermes is the authoritative owner; this boundary translates only verified dashboard operations. */
export class HermesWorkService extends Context.Service<
  HermesWorkService,
  {
    readonly query: (
      input: HermesWorkQueryInput,
    ) => Effect.Effect<HermesWorkQueryResult, HermesWorkError>;
    readonly mutate: (
      input: HermesWorkMutateInput,
    ) => Effect.Effect<{ message: string; threadId?: string }, HermesWorkError>;
  }
>()("t3/hermes/HermesWorkService") {}

export const makeHermesWorkService = Effect.gen(function* () {
  const dashboard = yield* HermesDashboardClient;
  const conversations = yield* HermesWorkConversationService;
  const repository = yield* HermesWorkRunRepository;
  const read = Effect.fn("HermesWorkService.read")(function* <A>(
    input: HermesDashboardRequest,
    schema: Schema.Codec<A, unknown, never, never>,
  ) {
    const value = yield* dashboard.request(input);
    return yield* Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(
        () =>
          new HermesWorkError({
            code: "invalid_response",
            message: "Hermes returned an unsupported response. Check the connected Hermes version.",
          }),
      ),
    );
  });
  const profileHome = Effect.fn("HermesWorkService.profileHome")(function* (
    providerInstanceId: string,
    profile: string,
  ) {
    const result = yield* read(
      { providerInstanceId, method: "GET", path: "/api/profiles" },
      Schema.Struct({
        profiles: Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String })),
      }),
    );
    const found = result.profiles.find((entry) => entry.name === profile);
    if (!found)
      return yield* new HermesWorkError({
        code: "not_found",
        message: "The Hermes assistant no longer exists.",
      });
    return found.path.replace(/\/$/u, "");
  });
  const query = Effect.fn("HermesWorkService.query")(function* (
    input: HermesWorkQueryInput,
  ): Effect.fn.Return<HermesWorkQueryResult, HermesWorkError> {
    const request = (
      path: string,
      query?: HermesDashboardRequest["query"],
    ): HermesDashboardRequest => ({
      providerInstanceId: input.providerInstanceId,
      profile: input.profile,
      method: "GET",
      path,
      ...(query ? { query } : {}),
    });
    const result = empty();
    switch (input.section) {
      case "artifacts":
      case "artifact":
        return { ...result, ...(yield* queryHermesWorkArtifacts(dashboard, input)) };
      case "automation": {
        const response = yield* dashboard.request(request("/api/config"));
        const automation = yield* Effect.try({
          try: () => decodeHermesWorkAutomation(response),
          catch: () =>
            new HermesWorkError({
              code: "invalid_response",
              message: "Hermes returned invalid automation settings.",
            }),
        });
        return { ...result, automation };
      }
      case "thread": {
        if (!input.id)
          return yield* new HermesWorkError({ code: "invalid_input", message: "Choose a thread." });
        const binding = yield* conversations.binding(input.id).pipe(
          Effect.mapError(
            () =>
              new HermesWorkError({
                code: "unavailable",
                message: "The Hermes thread binding could not be read.",
              }),
          ),
        );
        const details: import("@t3tools/contracts").HermesWorkThreadDetails = {
          threadId: input.id,
          status: "unbound",
          providerInstanceId: null,
          profile: null,
          sessionId: null,
          workspacePath: null,
          schedules: [],
          schedulesAvailable: false,
          gatewayRunning: null,
          gatewayState: null,
        };
        if (Option.isNone(binding))
          return {
            ...result,
            threadDetails: details,
            diagnostics: ["This thread has no associated Hermes session yet."],
          };
        const owner = binding.value;
        if (input.providerInstanceId && input.providerInstanceId !== owner.providerInstanceId)
          return yield* new HermesWorkError({
            code: "invalid_input",
            message: "This thread belongs to a different Hermes connection.",
          });
        const scope = { providerInstanceId: owner.providerInstanceId, profile: owner.profileKey };
        const identified = { ...details, ...scope, sessionId: owner.storedSessionKey };
        const native = yield* read(
          {
            ...scope,
            method: "GET",
            path: `/api/sessions/${encodeURIComponent(owner.storedSessionKey)}`,
          },
          Schema.Struct({ id: Schema.String, cwd: Schema.optional(Text) }),
        ).pipe(Effect.result);
        const diagnostics: string[] = [];
        if (native._tag === "Failure")
          diagnostics.push(
            "The associated Hermes session is unavailable. Its workspace could not be verified.",
          );
        if (native._tag === "Success" && native.success.id !== owner.storedSessionKey)
          return yield* new HermesWorkError({
            code: "invalid_response",
            message: "Hermes returned a different session.",
          });
        const gateway = yield* readHermesWorkGateway(dashboard, scope).pipe(Effect.result);
        if (gateway._tag === "Failure")
          diagnostics.push("Background scheduler status is unavailable.");
        const saved = yield* repository
          .list({ ...scope, sessionId: owner.storedSessionKey })
          .pipe(Effect.result);
        const jobId = (saved._tag === "Success" ? saved.success : []).find(
          (run) => run.id === owner.storedSessionKey,
        )?.jobId;
        const createdResult = yield* conversations.createdScheduleIds(input.id).pipe(Effect.result);
        const createdIds = createdResult._tag === "Success" ? createdResult.success : [];
        const scheduleResult =
          jobId || createdIds.length
            ? yield* query({ ...scope, section: "schedules" }).pipe(Effect.result)
            : null;
        if (scheduleResult?._tag === "Failure")
          diagnostics.push("The linked scheduled task is unavailable.");
        const schedules =
          scheduleResult?._tag === "Success"
            ? scheduleResult.success.schedules
                .filter((job) => job.id === jobId || createdIds.includes(job.id))
                .map((job) => ({
                  ...job,
                  relationship: createdIds.includes(job.id)
                    ? ("created_here" as const)
                    : ("run_of" as const),
                }))
            : [];
        return {
          ...result,
          diagnostics,
          threadDetails: {
            ...identified,
            status: native._tag === "Success" ? "bound" : "unavailable",
            workspacePath: native._tag === "Success" ? native.success.cwd || null : null,
            schedules,
            schedulesAvailable:
              saved._tag === "Success" &&
              createdResult._tag === "Success" &&
              scheduleResult?._tag !== "Failure",
            gatewayRunning: gateway._tag === "Success" ? gateway.success.running : null,
            gatewayState: gateway._tag === "Success" ? gateway.success.state : null,
          },
        };
      }
      case "sessions":
        return { ...result, sessions: yield* conversations.query(input) };
      case "status": {
        const status = yield* readHermesWorkGateway(dashboard, input);
        return {
          ...result,
          gatewayRunning: status.running,
          gatewayState: status.state,
          diagnostics: [
            status.running
              ? `Background gateway: ${status.state}. Scheduled work can execute while this environment remains online.`
              : `Background gateway: ${status.state}. Scheduled work is unavailable.${status.exitReason ? ` ${status.exitReason}` : ""}`,
          ],
        };
      }
      case "profiles": {
        const response = yield* read(request("/api/profiles"), Schema.Struct({ profiles: Rows }));
        return {
          ...result,
          profiles: response.profiles.map((p) => ({
            name: text(p.name),
            description: text(p.description),
            model: text(p.model),
            isDefault: flag(p.is_default),
          })),
        };
      }
      case "schedules": {
        const response = yield* read(request("/api/cron/jobs"), Rows);
        return {
          ...result,
          schedules: response.map((job) => ({
            id: text(job.id),
            profile: text(job.profile) || input.profile,
            name: text(job.name),
            prompt: text(job.prompt),
            schedule:
              text(job.schedule) ||
              text(nested(job.schedule).expr) ||
              text(nested(job.schedule).run_at) ||
              (number(nested(job.schedule).minutes) !== null
                ? `every ${number(nested(job.schedule).minutes)}m`
                : "") ||
              text(job.schedule_display),
            paused: flag(job.paused) || job.state === "paused",
            deliver: text(job.deliver) || "local",
            model: nullableText(job.model),
            nextRunAt: nullableText(job.next_run_at),
            lastRunAt: nullableText(job.last_run_at),
            lastStatus: nullableText(job.last_status),
            lastError: nullableText(job.last_error),
            lastDeliveryError: nullableText(job.last_delivery_error),
            continuity: Array.isArray(job.context_from) && job.context_from.includes("self"),
          })),
        };
      }
      case "runs": {
        const saved = yield* repository
          .list({
            providerInstanceId: input.providerInstanceId,
            profile: input.profile,
            ...(input.id ? { jobId: input.id } : {}),
          })
          .pipe(
            Effect.mapError(
              () =>
                new HermesWorkError({
                  code: "unavailable",
                  message: "Saved Hermes run history is unavailable.",
                }),
            ),
          );
        if (!input.id)
          return {
            ...result,
            runs: saved,
            diagnostics: [
              "History is synchronized in the background. Recent activity may take a moment to appear.",
            ],
          };
        const response = yield* read(
          request(`/api/cron/jobs/${encodeURIComponent(input.id)}/runs`, { limit: 100 }),
          Schema.Struct({ runs: Rows }),
        ).pipe(
          Effect.map((value) => ({ value, error: null })),
          Effect.catchTag("HermesWorkError", (error) => Effect.succeed({ value: null, error })),
        );
        if (!response.value)
          return {
            ...result,
            runs: saved,
            diagnostics: [response.error?.message ?? "Showing saved run history."],
          };
        const merged = new Map(saved.map((run) => [run.id, run]));
        for (const run of response.value.runs) {
          const previous = merged.get(text(run.id));
          merged.set(text(run.id), {
            id: text(run.id),
            profile: text(run.profile) || input.profile,
            title: text(run.title),
            startedAt: number(run.started_at),
            endedAt: number(run.ended_at),
            active: flag(run.is_active),
            jobId: input.id,
            status: nullableText(run.end_reason),
            deliveryStatus: null,
            content: previous?.content ?? nullableText(run.preview),
            readAt: previous?.readAt ?? null,
          });
        }
        return {
          ...result,
          runs: [...merged.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)),
          diagnostics:
            response.value.runs.length === 100
              ? ["Showing the latest 100 live runs plus saved history."]
              : [],
        };
      }
      case "run": {
        if (!input.id)
          return yield* new HermesWorkError({
            code: "invalid_input",
            message: "Choose a run to inspect its output.",
          });
        const scope = {
          providerInstanceId: input.providerInstanceId,
          profile: input.profile,
          id: input.id,
        };
        const response = yield* read(
          request(`/api/sessions/${encodeURIComponent(input.id)}/messages`, {
            limit: 500,
            order: "latest",
          }),
          Schema.Struct({ messages: Rows }),
        ).pipe(
          Effect.map((value) => ({ value, error: null })),
          Effect.catchTag("HermesWorkError", (error) => Effect.succeed({ value: null, error })),
        );
        let messages = response.value?.messages;
        if (!messages) {
          const saved = yield* repository.getResult(scope).pipe(
            Effect.mapError(
              () =>
                new HermesWorkError({
                  code: "unavailable",
                  message: "Saved output is unavailable.",
                }),
            ),
          );
          if (!saved)
            return yield* (
              response.error ??
                new HermesWorkError({ code: "not_found", message: "No saved output is available." })
            );
          const decoded = yield* decodeSavedMessages(saved).pipe(
            Effect.mapError(
              () =>
                new HermesWorkError({
                  code: "invalid_response",
                  message: "Saved output could not be read.",
                }),
            ),
          );
          messages = decoded.messages;
        }
        yield* repository
          .markRead({ ...scope, now: DateTime.formatIso(yield* DateTime.now) })
          .pipe(Effect.catch(() => Effect.void));
        return {
          ...result,
          content: messages
            .filter((m) => m.display_kind !== "hidden")
            .map((m) => `${text(m.role)}\n${text(m.display_content) || text(m.content)}`)
            .join("\n\n"),
          diagnostics: response.error
            ? ["Showing saved output. Hermes is currently unavailable."]
            : messages.length === 500
              ? ["Showing the latest 500 messages."]
              : [],
        };
      }

      case "skills": {
        const response = yield* read(request("/api/skills"), Rows);
        return {
          ...result,
          skills: response.map((skill) => ({
            name: text(skill.name),
            description: text(skill.description),
            enabled: flag(skill.enabled),
          })),
        };
      }
      case "skill": {
        if (!input.id)
          return yield* new HermesWorkError({ code: "invalid_input", message: "Choose a skill." });
        const response = yield* read(
          request("/api/skills/content", { name: input.id }),
          Schema.Struct({ content: Schema.String }),
        );
        return { ...result, content: response.content };
      }
      case "instructions": {
        const response = yield* read(
          request(`/api/profiles/${encodeURIComponent(input.profile)}/soul`),
          Schema.Struct({ content: Schema.String }),
        );
        return { ...result, content: response.content };
      }
      case "memory": {
        const file = input.path ?? "MEMORY.md";
        if (file !== "MEMORY.md" && file !== "USER.md")
          return yield* new HermesWorkError({
            code: "invalid_input",
            message: "Choose assistant or user memory.",
          });
        const home = yield* profileHome(input.providerInstanceId, input.profile);
        const path = `${home}/memories/${file}`;
        const response = yield* read(
          request("/api/fs/read-text", { path }),
          Schema.Struct({ text: Schema.String, truncated: Schema.Boolean }),
        ).pipe(
          Effect.catchTag("HermesWorkError", (error) =>
            error.code === "not_found"
              ? Effect.succeed({ text: "", truncated: false })
              : Effect.fail(error),
          ),
        );
        return {
          ...result,
          content: response.text,
          path,
          diagnostics: response.truncated ? ["Memory is too large to edit in full."] : [],
        };
      }
      case "channels": {
        const response = yield* read(
          request("/api/messaging/platforms"),
          Schema.Struct({ platforms: Rows }),
        );
        return {
          ...result,
          channels: response.platforms.map((channel) => ({
            id: text(channel.id),
            name: text(channel.name),
            description: text(channel.description),
            enabled: flag(channel.enabled),
            configured: flag(channel.configured),
            fields: rows(channel.env_vars).map((field) => ({
              name: text(field.key),
              label: text(field.label) || text(field.key),
              secret: true,
              configured: flag(field.is_set),
            })),
          })),
        };
      }
      case "files": {
        const path = input.path || (yield* profileHome(input.providerInstanceId, input.profile));
        const response = yield* read(
          request("/api/fs/list", { path }),
          Schema.Struct({ entries: Rows, error: Schema.optional(Text) }),
        );
        if (response.error)
          return yield* new HermesWorkError({
            code: "unavailable",
            message: `Cannot list files: ${response.error}`,
          });
        return {
          ...result,
          path,
          files: response.entries.map((file) => ({
            name: text(file.name),
            path: text(file.path),
            directory: flag(file.isDirectory),
            size: number(file.size),
          })),
        };
      }
      case "file": {
        if (!input.path)
          return yield* new HermesWorkError({ code: "invalid_input", message: "Choose a file." });
        const response = yield* read(
          request("/api/fs/read-text", { path: input.path }),
          Schema.Struct({
            text: Schema.String,
            path: Schema.String,
            binary: Schema.Boolean,
            truncated: Schema.Boolean,
          }),
        );
        return {
          ...result,
          content: response.binary ? null : response.text,
          path: response.path,
          diagnostics: response.binary
            ? ["This file is binary and cannot be displayed as text."]
            : response.truncated
              ? ["Showing a preview of this large file."]
              : [],
        };
      }
    }
  });
  const mutate = Effect.fn("HermesWorkService.mutate")(function* (input: HermesWorkMutateInput) {
    const { command } = input;
    const send = (method: HermesDashboardRequest["method"], path: string, body?: unknown) =>
      dashboard.request({
        providerInstanceId: input.providerInstanceId,
        profile: input.profile,
        method,
        path,
        ...(body !== undefined ? { body } : {}),
      });
    switch (command.type) {
      case "automation.save": {
        const patch = yield* Effect.try({
          try: () => hermesWorkAutomationPatch(command.timezone, command.allowAgentScheduling),
          catch: (cause) =>
            isWorkError(cause)
              ? cause
              : new HermesWorkError({
                  code: "invalid_input",
                  message: "Invalid automation settings.",
                }),
        });
        yield* send("PUT", "/api/config", patch);
        break;
      }
      case "conversation.open":
        return yield* conversations.open(input);
      case "gateway.start":
      case "gateway.stop":
        yield* send("POST", `/api/gateway/${command.type === "gateway.start" ? "start" : "stop"}`);
        break;
      case "schedule.create":
      case "schedule.update": {
        const fields = {
          name: command.name,
          prompt: command.prompt,
          schedule: command.schedule,
          deliver: command.deliver,
          ...(command.model !== undefined ? { model: command.model } : {}),
          ...(command.provider !== undefined ? { provider: command.provider } : {}),
          ...(command.paused !== undefined ? { paused: command.paused } : {}),
          ...(command.skills ? { skills: command.skills } : {}),
          ...(command.contextFrom ? { context_from: command.contextFrom } : {}),
          ...(command.enabledToolsets ? { enabled_toolsets: command.enabledToolsets } : {}),
        };
        if (command.continuity !== undefined) {
          let sources = command.contextFrom ?? [];
          if (command.type === "schedule.update" && command.contextFrom === undefined) {
            const current = yield* read(
              {
                providerInstanceId: input.providerInstanceId,
                profile: input.profile,
                method: "GET",
                path: `/api/cron/jobs/${encodeURIComponent(command.id)}`,
              },
              Schema.Struct({
                context_from: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
              }),
            );
            sources = current.context_from ?? [];
          }
          fields.context_from = hermesWorkContinuitySources(sources, command.continuity);
        }
        yield* command.type === "schedule.create"
          ? send("POST", "/api/cron/jobs", fields)
          : send("PUT", `/api/cron/jobs/${encodeURIComponent(command.id)}`, { updates: fields });
        break;
      }
      case "schedule.pause":
      case "schedule.resume":
      case "schedule.run":
      case "schedule.remove": {
        const action = command.type.slice("schedule.".length);
        yield* send(
          action === "remove" ? "DELETE" : "POST",
          `/api/cron/jobs/${encodeURIComponent(command.id)}${action === "remove" ? "" : `/${action === "run" ? "trigger" : action}`}`,
        );
        break;
      }
      case "profile.create":
        yield* send("POST", "/api/profiles", {
          name: command.name,
          description: command.description,
          ...(command.model ? { model: command.model } : {}),
          ...(command.provider ? { provider: command.provider } : {}),
        });
        break;
      case "profile.rename":
        yield* send("PATCH", `/api/profiles/${encodeURIComponent(command.name)}`, {
          new_name: command.newName,
        });
        break;
      case "profile.remove":
        yield* send("DELETE", `/api/profiles/${encodeURIComponent(command.name)}`);
        break;
      case "profile.describe":
        yield* send("PUT", `/api/profiles/${encodeURIComponent(command.name)}/description`, {
          description: command.description,
        });
        break;
      case "profile.model":
        yield* send("PUT", `/api/profiles/${encodeURIComponent(command.name)}/model`, {
          model: command.model,
          provider: command.provider,
        });
        break;
      case "instructions.save":
        yield* send("PUT", `/api/profiles/${encodeURIComponent(input.profile)}/soul`, {
          content: command.content,
        });
        break;
      case "skill.toggle":
        yield* send("PUT", "/api/skills/toggle", {
          profile: input.profile,
          name: command.name,
          enabled: command.enabled,
        });
        break;
      case "skill.create":
      case "skill.save":
        yield* send(
          command.type === "skill.create" ? "POST" : "PUT",
          command.type === "skill.create" ? "/api/skills" : "/api/skills/content",
          { profile: input.profile, name: command.name, content: command.content },
        );
        break;
      case "memory.save": {
        const home = yield* profileHome(input.providerInstanceId, input.profile);
        const path = `${home}/memories/${command.file}`;
        const current = yield* read(
          {
            providerInstanceId: input.providerInstanceId,
            method: "GET",
            path: "/api/fs/read-text",
            query: { path },
          },
          Schema.Struct({ text: Schema.String, truncated: Schema.Boolean }),
        ).pipe(
          Effect.catchTag("HermesWorkError", (error) =>
            error.code === "not_found"
              ? Effect.succeed({ text: "", truncated: false })
              : Effect.fail(error),
          ),
        );
        if (current.truncated || current.text !== command.expectedContent)
          return yield* new HermesWorkError({
            code: "conflict",
            message: "Memory changed since you opened it. Reload before saving.",
          });
        yield* send("POST", "/api/fs/write-text", { path, content: command.content });
        break;
      }
      case "channel.save":
        yield* send("PUT", `/api/messaging/platforms/${encodeURIComponent(command.id)}`, {
          profile: input.profile,
          enabled: command.enabled,
          env: command.values,
        });
        break;
    }
    return {
      message:
        command.type === "gateway.start" || command.type === "gateway.stop"
          ? "Hermes accepted the background service request. Refresh status to confirm the outcome."
          : command.type === "schedule.run"
            ? "Hermes accepted the run request. Refresh run history to inspect the outcome."
            : "Saved in Hermes.",
    };
  });
  return HermesWorkService.of({ query, mutate });
});
export const hermesWorkServiceLayer = Layer.effect(HermesWorkService, makeHermesWorkService);
