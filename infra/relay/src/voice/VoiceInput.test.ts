import type { VoiceTranscriptionRequest } from "@t3tools/contracts/relay";
import { expect, layer } from "@effect/vitest";
import { eq, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import { relayVoiceTranscriptionRequests, relayVoiceUsageDays } from "../persistence/schema.ts";
import * as PgliteRelayDb from "../testing/PgliteRelayDb.ts";
import * as VoiceInput from "./VoiceInput.ts";

const voiceConfig: RelayConfiguration.VoiceInputConfig = {
  enabled: true,
  openRouterApiKey: Redacted.make("sk-or-shared"),
  dailySeconds: 10,
  maxClipSeconds: 6,
  maxUploadBytes: 64 * 1024,
};

function relayConfig(voiceInput: RelayConfiguration.VoiceInputConfig | undefined) {
  return RelayConfiguration.RelayConfiguration.of({
    relayIssuer: "https://relay.example.test",
    apns: null,
    clerkSecretKey: Redacted.make("clerk-secret-key"),
    clerkPublishableKey: "pk_test_test",
    clerkJwtAudience: "t3-code-relay",
    apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
    cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
    cloudMintPublicKey: "cloud-mint-public-key",
    managedEndpointBaseDomain: undefined,
    managedEndpointNamespace: undefined,
    ...(voiceInput ? { voiceInput } : {}),
  });
}

/** Plays canned OpenRouter replies and records what the relay sent. */
function fakeOpenRouter(replies: Array<Response>) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const client = HttpClient.make((request) => {
    requests.push(request);
    const reply = replies.shift();
    return reply
      ? Effect.succeed(HttpClientResponse.fromWeb(request, reply))
      : Effect.die("unexpected OpenRouter request");
  });
  const body = (index: number) => {
    const sent = requests[index]?.body;
    if (sent?._tag !== "Uint8Array") throw new Error("expected a JSON body");
    return JSON.parse(new TextDecoder().decode(sent.body)) as Record<string, unknown>;
  };
  return { client, requests, body };
}

const completion = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Base64 of a mono 8-bit 8 kHz PCM WAV of silence. */
function wav(seconds: number): string {
  const dataBytes = 8000 * seconds;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (const [index, character] of [...value].entries()) {
      bytes[offset + index] = character.charCodeAt(0);
    }
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, dataBytes, true);
  bytes.fill(128, 44);
  return Buffer.from(bytes).toString("base64");
}

const request = (
  requestId: string,
  overrides?: Partial<VoiceTranscriptionRequest>,
): VoiceTranscriptionRequest => ({
  requestId,
  audio: { data: wav(3), format: "wav" },
  durationSeconds: 3,
  ...overrides,
});

/** Runs `use` against a VoiceInput built over the shared database. */
const withVoice = <A, E>(
  options: {
    readonly config?: RelayConfiguration.VoiceInputConfig | undefined;
    readonly openRouter?: ReturnType<typeof fakeOpenRouter>;
  },
  use: (voice: VoiceInput.VoiceInput["Service"]) => Effect.Effect<A, E, RelayDb.RelayDb>,
) =>
  VoiceInput.VoiceInput.pipe(
    Effect.flatMap(use),
    Effect.provide(
      VoiceInput.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              RelayConfiguration.RelayConfiguration,
              relayConfig("config" in options ? options.config : voiceConfig),
            ),
            Layer.succeed(HttpClient.HttpClient, (options.openRouter ?? fakeOpenRouter([])).client),
          ),
        ),
      ),
    ),
  );

const usage = (userId: string) =>
  RelayDb.RelayDb.pipe(
    Effect.flatMap((db) =>
      db
        .select({ audioSeconds: relayVoiceUsageDays.audioSeconds })
        .from(relayVoiceUsageDays)
        .where(eq(relayVoiceUsageDays.userId, userId)),
    ),
    Effect.map((rows) => rows.map((row) => row.audioSeconds)),
  );

layer(PgliteRelayDb.layer, { timeout: 60_000 })("VoiceInput", (it) => {
  it.effect("transcribes with the shared key and bills the WAV's own length", () => {
    const openRouter = fakeOpenRouter([completion("  Run the tests in apps/web.  ")]);
    return withVoice({ openRouter }, (voice) =>
      Effect.gen(function* () {
        yield* voice.updateSettings({
          userId: "user-transcribe",
          patch: { language: "en", dictionary: ["T3 Code", "t3 code", "Effect"] },
        });
        // The client under-reports; the WAV header says three seconds.
        const response = yield* voice.transcribe({
          userId: "user-transcribe",
          request: request("req-1", { durationSeconds: 1 }),
        });

        expect(response).toEqual({
          requestId: "req-1",
          text: "Run the tests in apps/web.",
          cleanupApplied: true,
          billedSeconds: 3,
        });
        expect(openRouter.requests[0]?.headers.authorization).toBe("Bearer sk-or-shared");
        const sent = openRouter.body(0);
        expect(sent.model).toBe("openai/gpt-audio");
        const prompt = JSON.stringify(sent.messages);
        expect(prompt).toContain('\\"T3 Code\\",\\"Effect\\"');
        expect(prompt).toContain('language \\"en\\"');
        expect(prompt).toContain("input_audio");
        expect(yield* usage("user-transcribe")).toEqual([3]);
      }),
    );
  });

  it.effect("returns the stored result for a retried request id without charging again", () => {
    const openRouter = fakeOpenRouter([completion("first"), completion("second")]);
    return withVoice({ openRouter }, (voice) =>
      Effect.gen(function* () {
        const first = yield* voice.transcribe({ userId: "user-retry", request: request("req") });
        const retried = yield* voice.transcribe({ userId: "user-retry", request: request("req") });

        expect(retried).toEqual(first);
        expect(openRouter.requests).toHaveLength(1);
        expect(yield* usage("user-retry")).toEqual([3]);
      }),
    );
  });

  it.effect("stops at the daily cap until the next UTC day", () => {
    const openRouter = fakeOpenRouter([completion("one"), completion("two"), completion("three")]);
    return withVoice({ openRouter }, (voice) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-13T18:00:00Z"));
        yield* voice.transcribe({ userId: "user-cap", request: request("a") });
        yield* voice.transcribe({ userId: "user-cap", request: request("b") });
        yield* voice.transcribe({ userId: "user-cap", request: request("c") });
        const rejected = yield* Effect.flip(
          voice.transcribe({ userId: "user-cap", request: request("d") }),
        );

        expect(rejected).toMatchObject({
          _tag: "VoiceInputRejectedError",
          code: "daily_limit_reached",
          retryAfterSeconds: 6 * 60 * 60,
        });
        expect(openRouter.requests).toHaveLength(3);
        expect((yield* voice.status({ userId: "user-cap" })).usedSecondsToday).toBe(9);

        yield* TestClock.setTime(Date.parse("2026-10-14T00:00:01Z"));
        expect((yield* voice.status({ userId: "user-cap" })).usedSecondsToday).toBe(0);
      }),
    );
  });

  it.effect("refunds the reservation when OpenRouter fails", () => {
    const openRouter = fakeOpenRouter([
      new Response("{}", { status: 429, headers: { "retry-after": "20" } }),
      new Response("{}", { status: 402 }),
      new Response("{}", { status: 503 }),
    ]);
    return withVoice({ openRouter }, (voice) =>
      Effect.gen(function* () {
        const failures = [];
        for (const id of ["rate", "credit", "outage"]) {
          failures.push(
            yield* Effect.flip(voice.transcribe({ userId: "user-refund", request: request(id) })),
          );
        }

        expect(failures).toMatchObject([
          { _tag: "VoiceInputUpstreamError", code: "rate_limited", retryAfterSeconds: 20 },
          { _tag: "VoiceInputUpstreamError", code: "voice_unavailable", status: 402 },
          { _tag: "VoiceInputUpstreamError", code: "transcription_failed", status: 503 },
        ]);
        expect(yield* usage("user-refund")).toEqual([0]);
      }),
    );
  });

  it.effect("charges for silence the model could not transcribe", () => {
    const openRouter = fakeOpenRouter([completion("   ")]);
    return withVoice({ openRouter }, (voice) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          voice.transcribe({ userId: "user-silence", request: request("quiet") }),
        );

        expect(error).toMatchObject({ code: "no_speech" });
        expect(yield* usage("user-silence")).toEqual([3]);
      }),
    );
  });

  it.effect(
    "rejects uploads over the size, length, and format limits before calling OpenRouter",
    () =>
      withVoice({}, (voice) =>
        Effect.gen(function* () {
          const codes = [];
          for (const candidate of [
            request("big", { audio: { data: wav(9), format: "wav" } }),
            request("long", { audio: { data: wav(1), format: "m4a" }, durationSeconds: 9 }),
            request("garbled", { audio: { data: "not base64!", format: "m4a" } }),
            request("headerless", { audio: { data: "AAAAAAAA", format: "wav" } }),
          ]) {
            const error = yield* Effect.flip(
              voice.transcribe({ userId: "user-limits", request: candidate }),
            );
            codes.push(error._tag === "VoiceInputRejectedError" ? error.code : error._tag);
          }

          expect(codes).toEqual([
            "audio_too_large",
            "clip_too_long",
            "invalid_audio",
            "invalid_audio",
          ]);
          expect(yield* usage("user-limits")).toEqual([]);
        }),
      ),
  );

  it.effect("is unavailable without a key or with the kill switch off", () =>
    Effect.gen(function* () {
      for (const config of [
        undefined,
        { ...voiceConfig, openRouterApiKey: undefined },
        { ...voiceConfig, enabled: false },
      ]) {
        yield* withVoice({ config }, (voice) =>
          Effect.gen(function* () {
            expect((yield* voice.status({ userId: "user-off" })).available).toBe(false);
            const error = yield* Effect.flip(
              voice.transcribe({ userId: "user-off", request: request("off") }),
            );
            expect(error).toMatchObject({ code: "voice_unavailable" });
          }),
        );
      }
    }),
  );

  it.effect("reads settings saved by the fork's relay and patches them", () =>
    withVoice({}, (voice) =>
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        yield* db.execute(sql`
          insert into relay_voice_input_settings (user_id, settings_json, created_at, updated_at)
          values ('user-legacy',
            ${JSON.stringify({
              model: "google/gemini-2.5-flash",
              language: "de",
              cleanup: { enabled: false },
              dictionary: ["Kubernetes"],
            })}::jsonb, 't0', 't0')`);

        const status = yield* voice.status({ userId: "user-legacy" });
        expect(status).toEqual({
          available: true,
          settings: { language: "de", dictionary: ["Kubernetes"], cleanup: false },
          limits: { maxClipSeconds: 6, maxUploadBytes: 64 * 1024, dailySeconds: 10 },
          usedSecondsToday: 0,
        });
        expect(
          yield* voice.updateSettings({ userId: "user-legacy", patch: { language: null } }),
        ).toEqual({ language: null, dictionary: ["Kubernetes"], cleanup: false });
      }),
    ),
  );

  it.effect("prunes stored transcripts after a day and usage after a week", () => {
    const openRouter = fakeOpenRouter([completion("kept briefly")]);
    return withVoice({ openRouter }, (voice) =>
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        yield* TestClock.setTime(Date.parse("2026-10-01T12:00:00Z"));
        yield* voice.transcribe({ userId: "user-prune", request: request("old") });

        yield* TestClock.setTime(Date.parse("2026-10-02T13:00:00Z"));
        yield* voice.pruneExpired;
        const requests = yield* db
          .select()
          .from(relayVoiceTranscriptionRequests)
          .where(eq(relayVoiceTranscriptionRequests.userId, "user-prune"));
        expect(requests).toHaveLength(0);
        expect(yield* usage("user-prune")).toEqual([3]);

        yield* TestClock.setTime(Date.parse("2026-10-09T00:00:00Z"));
        yield* voice.pruneExpired;
        expect(yield* usage("user-prune")).toEqual([]);
      }),
    );
  });
});
