// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageDay,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";

const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJsonString = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

function claudeLine(id: number, outputTokens: number, model = "claude-fable-5"): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: {
      id: `msg_${id}`,
      model,
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

const WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-07-31"),
  untilDay: UsageDay.make("2026-08-02"),
};

const setup = Effect.gen(function* () {
  // Resolve symlinked temp roots (macOS /var -> /private/var) so expected paths match.
  const home = yield* Effect.promise(async () =>
    NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-service-test-"))),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  const transcriptDir = NodePath.join(home, "claude", "projects", "proj");
  yield* Effect.promise(() => NodeFSP.mkdir(transcriptDir, { recursive: true }));
  return {
    home,
    transcript: NodePath.join(transcriptDir, "session.jsonl"),
    settings: {
      providers: {
        claudeAgent: { homePath: NodePath.join(home, "claude") },
        codex: { homePath: NodePath.join(home, "codex") },
      },
    },
  };
});

const serviceLayers = (input: {
  readonly prefix: string;
  readonly home: string;
  readonly settings: Parameters<typeof ServerSettings.layerTest>[0];
  readonly onRatesFetch?: () => void;
  /** Defaults to an unparsable document so every scan retries the fetch. */
  readonly ratesDocument?: unknown;
  readonly environment?: NodeJS.ProcessEnv;
}) =>
  ServerConfig.layerTest(process.cwd(), { prefix: input.prefix }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettings.layerTest(input.settings)),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            input.onRatesFetch?.();
            // Unparsable rates: every scan retries the fetch, which makes the
            // fetch count a boundary-level observation of how many scans ran.
            return HttpClientResponse.fromWeb(request, Response.json(input.ratesDocument ?? {}));
          }),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(HostProcessEnvironment, {
        GROK_HOME: NodePath.join(input.home, "grok"),
        ...input.environment,
      }),
    ),
  );

/** Outside `NARROW_WINDOW`, inside `WINDOW`. Seconds, as `utimes` takes them. */
const BEFORE_NARROW_WINDOW = Date.parse("2026-08-01T10:00:00Z") / 1000;
const NARROW_WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-09-01"),
  untilDay: UsageDay.make("2026-09-02"),
};

/**
 * A FIFO named like a transcript. A scan's read of it waits in `open` until
 * `openGate`, then fails at once, so a gate holds that scan's directory reads
 * in flight. Each waiting gate holds one libuv pool thread; keep at most three.
 */
const makeGate = (path: string, lastWriteSeconds?: number) =>
  Effect.promise(async () => {
    NodeChildProcess.execFileSync("mkfifo", [path]);
    if (lastWriteSeconds !== undefined) {
      await NodeFSP.utimes(path, lastWriteSeconds, lastWriteSeconds);
    }
  });

/**
 * Returns once a scan has opened the gate. A scan opens every file of a
 * directory at once, so it then holds the directory's transcripts open too.
 */
const openGate = (path: string) =>
  Effect.promise(async () => (await NodeFSP.open(path, "w")).close());

/** Replaces a file by rename, so a scan holding the old one keeps reading it. */
const replaceFile = (path: string, content: string) =>
  Effect.promise(async () => {
    await NodeFSP.writeFile(path + ".next", content);
    await NodeFSP.rename(path + ".next", path);
  });

function totalOutputTokens(summary: { buckets: readonly { totals: { outputTokens: number } }[] }) {
  return summary.buckets.reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0);
}

describe("UsageService", () => {
  it.live("reads configured and disabled accounts once across shared and aliased homes", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const codexHome = NodePath.join(home, "codex-account");
      const alias = NodePath.join(home, "codex-alias");
      const claudeHome = NodePath.join(home, "claude-account");
      const grokHome = NodePath.join(home, "grok-account");
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(transcript, claudeLine(1, 5));
        await NodeFSP.mkdir(NodePath.join(claudeHome, "projects"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(claudeHome, "projects", "session.jsonl"),
          claudeLine(2, 7),
        );
        await NodeFSP.mkdir(NodePath.join(codexHome, "sessions"), { recursive: true });
        await NodeFSP.symlink(codexHome, alias, "junction");
        await NodeFSP.writeFile(
          NodePath.join(codexHome, "sessions", "rollout.jsonl"),
          [
            { type: "session_meta", payload: { id: "codex-account-session" } },
            { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
            // A-B-A at one timestamp must preserve both equal A events.
            ...[11, 12, 11].map((outputTokens) => ({
              type: "event_msg",
              timestamp: "2026-08-01T10:00:00Z",
              payload: {
                type: "token_count",
                info: { last_token_usage: { input_tokens: 10, output_tokens: outputTokens } },
              },
            })),
          ]
            .map((line) => encodeUnknownJsonString(line))
            .join("\n") + "\n",
        );
        await NodeFSP.mkdir(NodePath.join(grokHome, "sessions", "session"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(grokHome, "sessions", "session", "updates.jsonl"),
          encodeUnknownJsonString({
            timestamp: Date.parse("2026-08-01T10:00:00Z") / 1000,
            method: "_x.ai/session/update",
            params: {
              sessionId: "grok-account-session",
              update: {
                sessionUpdate: "turn_completed",
                prompt_id: "prompt-1",
                usage: { inputTokens: 10, outputTokens: 13 },
              },
            },
          }) + "\n",
        );
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-accounts-test",
            home,
            settings: {
              ...settings,
              providerInstances: {
                [ProviderInstanceId.make("claude-work")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  enabled: false,
                  environment: [{ name: "CLAUDE_CONFIG_DIR", value: claudeHome, sensitive: false }],
                },
                [ProviderInstanceId.make("codex-work")]: {
                  driver: ProviderDriverKind.make("codex"),
                  environment: [{ name: "CODEX_HOME", value: codexHome, sensitive: false }],
                },
                [ProviderInstanceId.make("codex-alias")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: alias },
                },
                [ProviderInstanceId.make("codex-shadow")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: codexHome, shadowHomePath: NodePath.join(home, "shadow") },
                  environment: [
                    { name: "CODEX_HOME", value: NodePath.join(home, "ignored"), sensitive: false },
                  ],
                },
                [ProviderInstanceId.make("grok-work")]: {
                  driver: ProviderDriverKind.make("grok"),
                  environment: [{ name: "GROK_HOME", value: grokHome, sensitive: false }],
                },
              },
            },
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(summary), 59);
      yield* Effect.promise(() =>
        NodeFSP.rename(
          NodePath.join(codexHome, "sessions", "rollout.jsonl"),
          NodePath.join(codexHome, "sessions", "moved.jsonl"),
        ),
      );
      const moved = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(moved.buckets, summary.buckets);
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(codexHome, "sessions"), { recursive: true }),
      );
      const removed = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(removed.buckets, summary.buckets);

      const sources = summary.sources.filter((source) => source.status === "ok");
      assert.strictEqual(sources.length, 4);
      assert.strictEqual(
        sources.reduce((sum, source) => sum + source.scannedFiles, 0),
        4,
      );
      assert.strictEqual(
        sources.filter((source) => source.fingerprint.provider === "codex").length,
        1,
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "uses explicit account settings before environment and legacy homes, then refreshes them",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const configured = NodePath.join(home, "configured");
        const environmentHome = NodePath.join(home, "environment");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(transcript, claudeLine(1, 100));
          for (const [index, root] of [configured, environmentHome].entries()) {
            await NodeFSP.mkdir(NodePath.join(root, "projects"), { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(root, "projects", "session.jsonl"),
              claudeLine(index + 2, index + 7),
            );
          }
          await NodeFSP.mkdir(NodePath.join(configured, ".claude", "projects"), {
            recursive: true,
          });
          await NodeFSP.writeFile(
            NodePath.join(configured, ".claude", "projects", "wrong.jsonl"),
            claudeLine(4, 1000),
          );
        });
        yield* Effect.gen(function* () {
          const settingsService = yield* ServerSettings.ServerSettingsService;
          const service = yield* UsageService.make;
          const first = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(first), 7);
          assert.include(
            first.sources.map((source) => source.fingerprint.resolvedHomePath),
            NodePath.join(configured, "projects"),
          );
          yield* settingsService.updateSettings({
            providerInstances: {
              [ProviderInstanceId.make("claudeAgent")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: "" },
                environment: [
                  { name: "CLAUDE_CONFIG_DIR", value: environmentHome, sensitive: false },
                ],
              },
            },
          });
          const second = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(second), 8);
          assert.include(
            second.sources.map((source) => source.fingerprint.resolvedHomePath),
            NodePath.join(environmentHome, "projects"),
          );
        }).pipe(
          Effect.provide(
            serviceLayers({
              prefix: "usage-service-home-refresh-test",
              home,
              environment: { CLAUDE_CONFIG_DIR: NodePath.join(home, "host-ignored") },
              settings: {
                ...settings,
                providerInstances: {
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    config: { homePath: configured },
                    environment: [
                      { name: "CLAUDE_CONFIG_DIR", value: environmentHome, sensitive: false },
                    ],
                  },
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "uses inherited home variables when explicit default accounts have no home settings",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        const service = yield* UsageService.make.pipe(
          Effect.provide(
            serviceLayers({
              prefix: "usage-service-inherited-homes-test",
              home,
              environment: {
                CODEX_HOME: NodePath.join(home, "inherited-codex"),
                CLAUDE_CONFIG_DIR: NodePath.join(home, "claude"),
              },
              settings: {
                ...settings,
                providerInstances: {
                  [ProviderInstanceId.make("codex")]: {
                    driver: ProviderDriverKind.make("codex"),
                    config: {},
                  },
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    config: {},
                  },
                },
              },
            }),
          ),
        );
        const summary = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(summary), 5);
        assert.strictEqual(
          summary.sources.find((source) => source.fingerprint.provider === "codex")?.fingerprint
            .resolvedHomePath,
          NodePath.join(home, "inherited-codex", "sessions"),
        );
        assert.strictEqual(
          summary.sources.find((source) => source.fingerprint.provider === "grok")?.fingerprint
            .resolvedHomePath,
          NodePath.join(home, "grok", "sessions"),
        );
      }).pipe(Effect.scoped),
  );

  it.live("reprices unchanged transcripts when custom prices are added, edited, or removed", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const service = yield* UsageService.make;

        const original = yield* service.readSummary(WINDOW);
        assert.strictEqual(original.buckets[0]?.costUsd, 0);
        assert.strictEqual(original.buckets[0]?.unpricedRecords, 1);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
          },
        });
        const overridden = yield* service.readSummary(WINDOW);
        assert.closeTo(overridden.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
        assert.strictEqual(overridden.buckets[0]?.costSource, "modelPriced");
        assert.strictEqual(overridden.buckets[0]?.unpricedRecords, 0);
        assert.deepStrictEqual(overridden.buckets[0]?.totals, original.buckets[0]?.totals);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 16 },
          },
        });
        const edited = yield* service.readSummary(WINDOW);
        assert.closeTo(edited.buckets[0]?.costUsd ?? -1, 0.00012, 1e-12);

        yield* settingsService.updateSettings({ usagePriceOverrides: { "example-model": null } });
        const restored = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, original.buckets);
      }).pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-price-overrides-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("counts appended usage on a rescan of a grown transcript", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      const service = yield* UsageService.make.pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-grow-test", home, settings })),
      );

      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(first), 5);

      yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));
      const second = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(second), 12);
    }).pipe(Effect.scoped),
  );

  it.live(
    "keeps large-record totals and costs exact through append, dedupe, restart and cleanup",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const large = claudeLine(1, 9900).replace(
          '"message":',
          '"padding":' + encodeUnknownJsonString("x".repeat(9 * 1024 * 1024)) + ',"message":',
        );
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, large));
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const first = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(first), 9900);
          assert.closeTo(
            first.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
            0.4951,
            1e-12,
          );
          const warm = yield* service.readSummary(WINDOW);
          assert.deepStrictEqual(warm.buckets, first.buckets);
          // The repeated content block has the same message/request identity.
          yield* Effect.promise(() => NodeFSP.appendFile(transcript, large + claudeLine(2, 100)));
          const appended = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(appended), 10000);
          assert.strictEqual(
            appended.buckets.reduce((sum, bucket) => sum + bucket.totals.uncachedInputTokens, 0),
            20,
          );
          const restarted = yield* UsageService.make;
          const restored = yield* restarted.readSummary(WINDOW);
          assert.deepStrictEqual(restored.buckets, appended.buckets);
          yield* Effect.promise(() => NodeFSP.rm(transcript));
          const afterCleanup = yield* UsageService.make;
          assert.deepStrictEqual(
            (yield* afterCleanup.readSummary(WINDOW)).buckets,
            appended.buckets,
          );
        }).pipe(
          Effect.provide(
            serviceLayers({
              prefix: "usage-service-large-record-test",
              home,
              settings,
              ratesDocument: {
                "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "upgrades a v4 cache: reprices live Codex tiers, keeps deleted rollouts, leaves v4 intact",
    () =>
      Effect.gen(function* () {
        const { home, settings } = yield* setup;
        const sessions = NodePath.join(home, "codex", "sessions");
        const rollout = (sessionId: string, outputTokens: number) =>
          [
            { type: "session_meta", payload: { id: sessionId } },
            { type: "turn_context", payload: { model: "gpt-6-astra" } },
            {
              type: "event_msg",
              payload: {
                type: "thread_settings_applied",
                thread_settings: { service_tier: "ultrafast" },
              },
            },
            {
              type: "event_msg",
              timestamp: "2026-08-01T10:00:00Z",
              payload: {
                type: "token_count",
                info: { last_token_usage: { input_tokens: 0, output_tokens: outputTokens } },
              },
            },
          ]
            .map((line) => encodeUnknownJsonString(line))
            .join("\n") + "\n";
        const live = NodePath.join(sessions, "live.jsonl");
        const deleted = NodePath.join(sessions, "deleted.jsonl");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(sessions, { recursive: true });
          await NodeFSP.writeFile(live, rollout("live", 10));
          await NodeFSP.writeFile(deleted, rollout("deleted", 20));
        });

        yield* Effect.gen(function* () {
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const cachePath = NodePath.join(stateDir, "usage-scan-cache-v5.json");
          const legacyPath = NodePath.join(stateDir, "usage-scan-cache.json");
          yield* (yield* UsageService.make).readSummary(WINDOW);

          // Rewrite the cache as a v4 server left it: every Codex record at
          // speed 0 (standard), and no tier in the reducer state.
          const legacy = yield* Effect.promise(async () => {
            const document = decodeUnknownJsonString(await NodeFSP.readFile(cachePath, "utf8")) as {
              files: Record<string, { r: unknown[][]; cs: { speed?: unknown } }>;
            };
            for (const file of Object.values(document.files)) {
              file.r = file.r.map((row) => [...row.slice(0, 10), 0]);
              delete file.cs.speed;
            }
            const text = encodeUnknownJsonString({ ...document, version: 4 });
            await NodeFSP.writeFile(legacyPath, text);
            await NodeFSP.rm(cachePath);
            await NodeFSP.rm(deleted);
            return text;
          });

          const summary = yield* (yield* UsageService.make).readSummary(WINDOW);
          // The live rollout re-parses at the ultrafast rate (10 x 6); the
          // deleted one keeps its saved v4 usage at the standard rate (20 x 1).
          assert.strictEqual(totalOutputTokens(summary), 30);
          assert.strictEqual(
            summary.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
            80,
          );
          // A v4 server sharing this state directory still finds its own cache.
          assert.strictEqual(
            yield* Effect.promise(() => NodeFSP.readFile(legacyPath, "utf8")),
            legacy,
          );
        }).pipe(
          Effect.provide(
            serviceLayers({
              prefix: "usage-service-v4-upgrade-test",
              home,
              settings,
              ratesDocument: {
                "gpt-6-astra": {
                  input_cost_per_token: 0,
                  output_cost_per_token: 1,
                  input_cost_per_token_ultrafast: 0,
                  output_cost_per_token_ultrafast: 6,
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live("preserves saved tokens, costs and sessions after transcript cleanup and restart", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const alias = NodePath.join(home, "claude-alias");
      yield* Effect.promise(() =>
        NodeFSP.symlink(NodePath.join(home, "claude"), alias, "junction"),
      );
      const content = claudeLine(1, 5);
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, content));
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const first = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(first), 5);
        assert.isAbove(first.buckets[0]?.costUsd ?? 0, 0);

        yield* Effect.promise(() => NodeFSP.rm(transcript));
        const deleted = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(deleted.buckets, first.buckets);
        assert.deepStrictEqual(deleted.sources, first.sources);

        const restarted = yield* UsageService.make;
        const restored = yield* restarted.readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, first.buckets);
        assert.deepStrictEqual(restored.sources, first.sources);

        // A moved transcript must not count the saved usage twice.
        yield* Effect.promise(() => NodeFSP.writeFile(transcript + ".jsonl", content));
        const moved = yield* restarted.readSummary(WINDOW);
        assert.deepStrictEqual(moved.buckets, first.buckets);
        assert.strictEqual(moved.sources[0]?.distinctSessions, 1);

        const replacementProjects = NodePath.join(home, "replacement-projects");
        yield* Effect.promise(() => NodeFSP.mkdir(replacementProjects));
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(home, "claude", "projects"), { recursive: true }),
        );
        const afterRootCleanup = yield* UsageService.make;
        const missingRoot = yield* afterRootCleanup.readSummary(WINDOW);
        assert.deepStrictEqual(missingRoot.buckets, first.buckets);
        assert.strictEqual(missingRoot.sources[0]?.distinctSessions, 1);
        assert.strictEqual(missingRoot.sources[0]?.status, "ok");
        assert.deepStrictEqual(missingRoot.sources[0]?.fingerprint, first.sources[0]?.fingerprint);
        yield* Effect.promise(async () => {
          const projects = NodePath.join(home, "claude", "projects");
          await NodeFSP.rename(replacementProjects, projects);
          await NodeFSP.writeFile(NodePath.join(projects, "new.jsonl"), claudeLine(2, 7));
        });
        const recreated = yield* afterRootCleanup.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(recreated), 12);
        assert.deepStrictEqual(recreated.sources[0]?.fingerprint, first.sources[0]?.fingerprint);

        const merged = mergeUsage(
          [
            {
              environmentId: EnvironmentId.make("cleanup-test"),
              label: "test",
              summary: recreated,
            },
            {
              environmentId: EnvironmentId.make("other-environment"),
              label: "before cleanup",
              summary: first,
            },
          ],
          missingRoot.contractVersion,
        );
        assert.strictEqual(merged.outputTokens, 12);
        assert.strictEqual(merged.sessions, 1);
        assert.strictEqual(merged.costUsd, recreated.buckets[0]?.costUsd);

        const outsideWindow = yield* restarted.readSummary({
          ...WINDOW,
          sinceDay: UsageDay.make("2026-08-02"),
        });
        assert.deepStrictEqual(outsideWindow.buckets, []);
        assert.strictEqual(outsideWindow.sources[0]?.distinctSessions, 0);
      }).pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-cleanup-test",
            home,
            settings: { providers: { ...settings.providers, claudeAgent: { homePath: alias } } },
            ratesDocument: {
              "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
            },
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("credits the same copy of a duplicate after its transcripts are deleted", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const dir = NodePath.dirname(transcript);
      // The walk-first file is the original, padded so it finishes parsing
      // after the small fork copy that repeats its record under a new session.
      const [first = "", second = ""] = yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(dir, "a.jsonl"), "");
        await NodeFSP.writeFile(NodePath.join(dir, "b.jsonl"), "");
        return (await NodeFSP.readdir(dir)).map((name) => NodePath.join(dir, name));
      });
      const forked = (line: string) => line.replace('"session-1"', '"session-2"');
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(
          first,
          claudeLine(1, 5).replace(
            '"message":',
            '"padding":' + encodeUnknownJsonString("x".repeat(9 * 1024 * 1024)) + ',"message":',
          ),
        );
        await NodeFSP.writeFile(second, forked(claudeLine(1, 5)) + forked(claudeLine(2, 7)));
      });
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const live = yield* service.readSummary(WINDOW);
        assert.strictEqual(live.buckets[0]?.sessions, 2);

        yield* Effect.promise(() => Promise.all([NodeFSP.rm(first), NodeFSP.rm(second)]));
        const saved = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(saved.buckets, live.buckets);
        assert.deepStrictEqual(saved.sources, live.sources);
        const restored = yield* (yield* UsageService.make).readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, live.buckets);
      }).pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-copy-order-test", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "keeps a newer cached read when a slower scan of another window finishes later",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const dir = NodePath.dirname(transcript);
        const probe = NodePath.join(dir, "probe.jsonl");
        const hold = NodePath.join(dir, "hold.jsonl");
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        yield* makeGate(probe, BEFORE_NARROW_WINDOW);
        yield* makeGate(hold, BEFORE_NARROW_WINDOW);
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const wide = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
          yield* openGate(probe);
          yield* replaceFile(transcript, claudeLine(1, 5) + claudeLine(2, 7));
          // The narrow scan caches the newer read while the wide one waits.
          yield* service.readSummary(NARROW_WINDOW);
          yield* openGate(hold);
          yield* Fiber.join(wide);

          yield* Effect.promise(() =>
            Promise.all([transcript, probe, hold].map((path) => NodeFSP.rm(path))),
          );
          assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 12);
        }).pipe(
          Effect.provide(
            serviceLayers({ prefix: "usage-service-stale-read-test", home, settings }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "keeps the later read when a scan that read earlier finishes first",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const dir = NodePath.dirname(transcript);
        const gate = (name: string) => NodePath.join(dir, `${name}.jsonl`);
        const wideProbe = gate("wide-probe");
        const wideHold = gate("wide-hold");
        const narrowProbe = gate("narrow-probe");
        const narrowHold = gate("narrow-hold");
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        yield* makeGate(wideProbe, BEFORE_NARROW_WINDOW);
        yield* makeGate(wideHold, BEFORE_NARROW_WINDOW);
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const wide = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
          yield* openGate(wideProbe);
          yield* replaceFile(transcript, claudeLine(1, 5) + claudeLine(2, 7));
          // Made after the wide scan's walk, so only the narrow scan waits on them.
          yield* makeGate(narrowProbe);
          yield* makeGate(narrowHold);
          const narrow = yield* service.readSummary(NARROW_WINDOW).pipe(Effect.forkChild);
          yield* openGate(narrowProbe);
          // Both scans started from an empty cache entry; the earlier read lands first.
          yield* openGate(wideHold);
          yield* Fiber.join(wide);
          yield* openGate(narrowHold);
          yield* Fiber.join(narrow);

          yield* Effect.promise(() =>
            Promise.all(
              [transcript, wideProbe, wideHold, narrowProbe, narrowHold].map((path) =>
                NodeFSP.rm(path),
              ),
            ),
          );
          assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 12);
        }).pipe(
          Effect.provide(serviceLayers({ prefix: "usage-service-late-read-test", home, settings })),
        );
      }).pipe(Effect.scoped),
  );

  it.live("reports saved usage of a removed directory only for windows it reaches", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(transcript, claudeLine(1, 5));
        const lastWrite = Date.parse("2026-08-01T10:00:00Z") / 1000;
        await NodeFSP.utimes(transcript, lastWrite, lastWrite);
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-saved-window-test", home, settings }),
        ),
      );
      const first = yield* service.readSummary(WINDOW);
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(home, "claude", "projects"), { recursive: true }),
      );

      const reached = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(reached.buckets, first.buckets);
      assert.strictEqual(reached.sources[0]?.status, "ok");

      // A missing source cannot claim this directory from another environment
      // that still reads it, so it adds nothing to a window after its last write.
      const later = yield* service.readSummary({
        timeZone: "UTC",
        sinceDay: UsageDay.make("2026-08-10"),
        untilDay: UsageDay.make("2026-08-12"),
      });
      assert.deepStrictEqual(later.buckets, []);
      assert.strictEqual(later.sources[0]?.status, "missing");
      assert.strictEqual(later.sources[0]?.scannedFiles, 0);
    }).pipe(Effect.scoped),
  );

  it.live("shares one scan between concurrent identical requests", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-flight-test",
            home,
            settings,
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const [first, second] = yield* Effect.all(
        [service.readSummary(WINDOW), service.readSummary(WINDOW)],
        { concurrency: 2 },
      );
      assert.deepStrictEqual(first, second);
      assert.strictEqual(ratesFetches, 1);

      // A later request is fresh work again, not a stale cached answer.
      yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 2);
    }).pipe(Effect.scoped),
  );

  it.live("refetches a rate table inside its TTL only when the client asks", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-rates-refresh-test",
            home,
            settings,
            ratesDocument: {
              "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
            },
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 1);
      assert.strictEqual(first.pricing.status, "fresh");

      // Inside the daily TTL a plain rescan keeps the cached table.
      yield* TestClock.adjust(Duration.minutes(2));
      yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 1);

      // An explicit refresh fetches again so a newly listed model gets priced.
      // A burst of refreshes shares that one fetch.
      const [refreshed] = yield* Effect.all([service.refreshRates, service.refreshRates], {
        concurrency: 2,
      });
      assert.strictEqual(ratesFetches, 2);
      assert.strictEqual(refreshed.status, "fresh");
      assert.strictEqual(refreshed.knownModels, 1);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("does not orphan an in-flight scan when its first caller is interrupted", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-interruption-test", home, settings }),
        ),
      );

      let orphanedAt: number | undefined;
      for (let interruptAt = 1; interruptAt <= 31; interruptAt += 1) {
        const tasks: Array<() => void> = [];
        const dispatcher: Scheduler.SchedulerDispatcher = {
          scheduleTask: (task) => tasks.push(task),
          flush: () => {
            let task: (() => void) | undefined;
            while ((task = tasks.shift()) !== undefined) task();
          },
        };

        let requestFiber: Fiber.Fiber<unknown, unknown> | undefined;
        let requestChecks = 0;
        const scheduler: Scheduler.Scheduler = {
          executionMode: "async",
          makeDispatcher: () => dispatcher,
          shouldYield: (fiber) => {
            if (fiber !== requestFiber) return false;
            requestChecks += 1;
            if (requestChecks !== interruptAt) return false;
            fiber.interruptUnsafe();
            return true;
          },
        };

        // Each candidate needs a distinct key because the broken case leaves
        // its entry in the service's private in-flight map. The invalid window
        // keeps the real scan synchronous once its detached fiber starts.
        const input: UsageSummaryInput = {
          ...WINDOW,
          sinceDay: UsageDay.make("2026-09-01"),
          untilDay: UsageDay.make(`2026-08-${String(interruptAt).padStart(2, "0")}`),
        };
        const first = yield* service
          .readSummary(input)
          .pipe(
            Effect.exit,
            Effect.provideService(Scheduler.Scheduler, scheduler),
            Effect.forkChild,
          );
        requestFiber = first;
        yield* Effect.yieldNow;
        dispatcher.flush();

        const second = yield* service.readSummary(input).pipe(
          Effect.match({
            onFailure: (error) => error.reason,
            onSuccess: () => "success" as const,
          }),
          Effect.provideService(Scheduler.Scheduler, scheduler),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        dispatcher.flush();
        const secondExit = second.pollUnsafe();
        if (secondExit === undefined) {
          second.interruptUnsafe();
          orphanedAt = interruptAt;
          break;
        }
        if (Exit.isFailure(secondExit)) {
          assert.fail("the matching request fiber was interrupted");
        }
        assert.strictEqual(secondExit.value, "invalidWindow");
      }

      assert.isUndefined(
        orphanedAt,
        `interruption left the next matching request pending at scheduler check ${orphanedAt}`,
      );
    }).pipe(Effect.scoped),
  );
});
