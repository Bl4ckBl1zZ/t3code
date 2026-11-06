# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. Each recording has one destination, chosen in this order: an environment the
user granted audio to, then the T3 Connect relay when signed in and the relay reports
voice on, then on-device transcription on mobile. A granted environment never falls
back to the relay or the device, and the relay never falls back to an environment.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced. A
transcriber may expose a streaming session, in which case audio leaves during
capture and `finish` replaces the file-based `transcribe`.

## Where audio may go

Only an explicit audio grant authorizes off-device transcription. On mobile the
grant is stored in device-bound secure storage, outside preference backups. The
recorder is the same for both destinations; only a finished recording can be
uploaded, and its grant is checked again after native decoding and before dispatch.
The [web grant](../../apps/web/src/speech/voiceConsent.ts) lives outside the preferences snapshot so another
window saving unrelated settings cannot resurrect a revoked grant. Each new
choice gets a distinct grant, even if the destination was previously selected. The
[web hook](../../apps/web/src/speech/useEnvironmentSpeechInput.ts) binds a
recording controller to the prepared connection of that destination and to
nothing else. When the destination changes, disconnects, or stops advertising the
`voiceTranscription` capability, the controller is disposed: a recording in
progress is discarded, a failed recording kept for retry is deleted, and nothing
falls back to another environment. Every sender in the web app, including the
settings page's transcription test, goes through that hook. The microphone loopback
test captures separately for local playback and sends nothing. The transport
refuses redirects so credentials and audio cannot follow one to another host.

Transcript cleanup requires its own grant, off by default.
It sends text, never audio, to the text generation provider of the draft's
own environment, because that is where the provider credentials live. A later
backend adds its own destination kind, disclosure, and transcriber; capture and
the controller stay as they are.

## T3 Connect relay

Signed-in T3 Connect accounts without a granted environment transcribe through the
relay, which calls OpenRouter with one operator-owned key
([runbook](../operations/relay-voice-input.md)). The relay, not an environment, owns this
because the key and its spend belong to the operator and the daily cap needs a stable
identity across devices: the Clerk account.

The relay's caps are the cost boundary, so they cannot depend on client honesty where
avoidable. Usage is reserved in Postgres before the upstream call, atomically against
the daily cap, and refunded only when the upstream call fails. Web and desktop send WAV
so the relay bills by the header's length; mobile sends m4a and its reported length,
bounded by the clip limit, which the controller keeps for a retried upload. A client
request id makes retries idempotent: the relay stores the response for a day and returns
it without calling upstream or billing again. Clients must therefore reuse the id when
resending the same clip, and only then.

The web relay path keeps its own [session store](../../apps/web/src/voice/webVoiceSession.ts)
because MediaRecorder yields blobs rather than file URIs, and it must outlive the composer:
switching threads mid-transcription delivers the text to that thread's stored draft. The
level meter writes styles directly and only when the quantized level changes, so an idle
or silent recording causes no React renders or paints.

## Server side

The [speech service](../../apps/server/src/speech/SpeechService.ts) runs
transcribe-cpp in a child process so a hung native call can be killed without
taking the server down; see [native.ts](../../apps/server/src/speech/native.ts)
for the packaging constraints (Node SEA, Electron ASAR). One native request runs
at a time. Batch uploads carry their options in the body framing defined in
[shared/speech.ts](../../packages/shared/src/speech.ts); streaming sends them in
the socket's first command. Model files and the selected model, hardware
placement, and unload timeout are environment state in server settings.

The Silero silence detector is optional. If its download fails, recordings use
raw audio during the retry cooldown so a detector outage cannot block dictation.
Explicitly installing a speech model also retries the detector without waiting.

## Cancellation and resource ownership

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results, and the
[relay transcriber](../../apps/mobile/src/features/voice-input/relayVoiceTranscriber.ts)
reports cancellation over whatever an aborted request returned. On the server,
interrupting a batch request kills the worker process instead; the next request
reloads the model.
