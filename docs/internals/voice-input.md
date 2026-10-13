# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text.

## Where transcription runs

Signed-in T3 Connect accounts transcribe through the relay, which calls OpenRouter
with one operator-owned key ([runbook](../operations/relay-voice-input.md)). The relay,
not an environment, owns this because the key and its spend belong to the operator and
the daily cap needs a stable identity across devices: the Clerk account. Environments
never see voice audio. Signed out, or when the relay reports voice off, mobile falls back
to Apple's on-device transcription on supported iPhones; web and desktop hide the action.

The relay's caps are the cost boundary, so they cannot depend on client honesty where
avoidable. Usage is reserved in Postgres before the upstream call, atomically against
the daily cap, and refunded only when the upstream call fails. Web and desktop send WAV
so the relay bills by the header's length; mobile sends m4a and its reported length,
bounded by the clip limit. A client request id makes retries idempotent: the relay stores
the response for a day and returns it without calling upstream or billing again. Clients
must therefore reuse the id when resending the same clip, and only then.

## Clients

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns a mobile recording while the client supplies capture and transcription. Preparation
binds the transcriber, the resolved locale, and the clip limit for the whole recording.
Draft ownership, text, and revision are captured before recording and checked before
insertion, so a late transcript cannot overwrite a draft that was edited or replaced.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results, and the
[relay transcriber](../../apps/mobile/src/features/voice-input/relayVoiceTranscriber.ts)
reports cancellation over whatever an aborted request returned.

The web client keeps its own [session store](../../apps/web/src/voice/webVoiceSession.ts)
because MediaRecorder yields blobs rather than file URIs, and it must outlive the composer:
switching threads mid-transcription delivers the text to that thread's stored draft. The
level meter writes styles directly and only when the quantized level changes, so an idle
or silent recording causes no React renders or paints.
