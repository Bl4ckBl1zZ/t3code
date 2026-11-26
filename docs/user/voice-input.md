# Voice input

Dictate into the composer, citation comments, diff/file annotations, PR comments, and desktop browser annotations. Transcripts land in your draft for review—nothing is sent to an agent until you submit.

## Choose where audio goes

Each recording goes to one place: a destination you chose in **Settings → Voice**, if any (T3 Code never falls back from it to anything else); otherwise, signed in to T3 Connect, your account's [T3 Connect voice input](#t3-connect-voice-input); otherwise, on iPhone and Android, the device itself. With none of these, web and desktop show no microphone button.

- **Web and desktop**: Nothing is recorded or sent until you sign in to T3 Connect or choose a destination in **Settings → Voice → Transcribe with**:
  - **On this Mac (Apple Speech)** (macOS 26+ desktop): Transcribes locally on your Mac (silence filtering and filler removal unavailable; dictionary applies only with cleanup enabled).
  - **A connected environment**: Sends audio over your authenticated connection to transcribe locally on that host and discards the audio. Never silently fails over to another host.
  - **Cloud providers (OpenAI, Grok Voice Transcribe, OpenRouter)**: Configure an API key (or [secret reference](./secrets.md)) on an environment to forward recordings to that provider. OpenRouter lets each user pick a model from its live STT catalog and requests zero data retention.
- **Mobile (iOS and Android)**: Unless signed in to T3 Connect, transcribes on-device by default (iOS 26+ or Android 12+ with compatible Google speech services; first use may download a speech model, then works offline). To transcribe on a paired environment or cloud provider instead, configure **Settings → Voice → Transcribe on**. Keep T3 Code open while dictating on Android.

## Set up a local transcription model

In **Settings → Voice → Transcription**, filter by language, download a model, and select **Use model** (reuses matching files from Handy or the Hugging Face cache, or link an existing file via **Use existing**—Core ML/ONNX/MLX builds aren't supported).

- **Advanced**: Configure GPU/CPU (**Auto** falls back to CPU once on GPU error), idle unload timeout, and **Streaming transcription** (disable if live preview lags).

## Dictate and shortcuts

- Press the microphone button or `mod+shift+d` to start/stop (`Esc` discards; max recording length: **5 minutes**; T3 Connect dictation uses `mod+alt+v` and its own clip limit).
- Configure tap vs. hold behavior in **Settings → Voice → Dictation shortcut** (**Auto**, **Hold**, or **Toggle**), or remap the chord in [Keybindings](./keybindings.md).
- Pressing **Send** (or Save/Comment/Submit) while recording finishes transcription and submits automatically.

## Improve recognition and cleanup

- **Language & translation**: Pick a language or **Auto** (plus **Translate to English** where supported).
- **Personal & project dictionaries**: Add custom terms and common misspelling aliases in **Settings → Voice** (device-level) or scoped to a project/environment (up to 100 combined entries; project entries take priority).
- **Silence filtering & filler removal**: Skip silence (on by default) and strip hesitation words.
- **Transcript cleanup** (off by default): Sends the finished transcript and surrounding draft text (never audio) to your [text generation model](./text-generation.md) (or a dedicated **Cleanup model**) to fix punctuation, numbers, and spoken self-corrections (optionally using a custom **Correction cue** like "scratch that"). Press **Skip** during cleanup to insert raw text.

## Microphones and testing

- **Microphone priority**: Rank built-in, wired, Bluetooth, and CarPlay (iOS) devices in **Settings → Voice**—T3 Code uses the first connected device in the list.
- **Test**: Use **Test microphone** (local 10-second loopback, no transcription) to verify input, and **Test model** to preview raw transcription without cleanup.
- Browser recording requires **HTTPS** or `localhost`—for plain-HTTP remote servers, use the desktop app.

## T3 Connect voice input

Signed in to T3 Connect, voice input works on web, desktop, and mobile using your account's settings, unless you chose an environment in **Settings → Voice**.

- **Sign in**: Open **Settings → Connections** and sign in to T3 Connect; the microphone then appears in the composer. If it does not, your T3 Connect service has voice input turned off. Signed-out mobile apps, or ones whose service has voice input off, fall back to on-device dictation.
- **Microphone access**: The first recording asks for permission. If you declined, allow it in your browser's site settings, or on macOS in **System Settings → Privacy & Security → Microphone**.

### Dictate with T3 Connect

- **Tap** the microphone to start, then click it again to transcribe. **Hold** it to talk and release to transcribe; slide up before releasing to discard.
- On web and desktop, press `mod+alt+v` to start or stop hands-free dictation (remap **Composer: Voice Input** in **Settings → Keybindings**). `Esc` discards.
- On iPhone and Android, use the composer's microphone as usual; recordings are transcribed through your account with the same language, cleanup, dictionary, and daily allowance as on desktop.

The text goes where your cursor was when you started. If you switch threads while transcribing, it is added to the draft of the thread you dictated into, and you cannot send that draft until transcription finishes.

A recording stops by itself at the clip limit (two minutes unless the service sets another length); the composer counts down the last ten seconds. If transcription fails for a temporary reason, use the retry button next to the microphone. Retrying sends the same recording and is not counted twice.

### T3 Connect settings

**Settings → T3 Connect voice** on web and desktop holds settings that follow your account to every device, and shows how much of today's allowance you have used:

- **Language**: **Automatic** detects it for each recording; choosing one helps with short clips and accents.
- **Clean up transcripts**: Fixes punctuation and capitalization and drops filler words such as "um", without rewording what you said.
- **Dictionary**: Names and terms to spell exactly, one per line, up to 200.

### Daily allowance

Each account can transcribe 30 minutes of audio per day unless the service sets another amount; the allowance resets at midnight UTC. A recording counts for its length. Recordings in which no speech was found still count; transcriptions that fail on the service's side do not. When you reach the limit, T3 Code tells you when it resets.

### Privacy

Recordings travel through T3 Connect to OpenRouter and on to the speech model provider, OpenAI, which return the text. T3 Connect does not store audio. It keeps the resulting text for up to a day so a retried request returns the same transcript, then deletes it. Daily usage totals are kept for a week. Your settings are stored with your account until you change them.
