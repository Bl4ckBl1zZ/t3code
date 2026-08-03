# Voice Input

Dictate prompts instead of typing them. Voice Input records from your microphone, transcribes the audio, optionally cleans up filler words and punctuation, and inserts the result into the composer at your cursor.

Voice Input is available in the chat composer on web, desktop, and mobile.

## Requirements

- Sign in to T3 Connect.
- Connect an OpenRouter account under **Settings → Integrations → OpenRouter**. Your API key is validated when you save it, encrypted at rest, and never returned to clients. Audio and transcripts are processed by OpenRouter and the upstream model providers you select.

## Recording

There are two ways to record:

- **Tap** the microphone button (or press `⌘⇧M` / `Ctrl⇧M` on web and desktop) to start a hands-free recording, then stop it when you're done.
- **Hold** the microphone button to record only while you keep it pressed. Release to transcribe, or **slide up** onto the ✕ and release to throw the recording away. Very short accidental presses are discarded automatically.

Releasing a hold never sends your message — the transcript is always inserted into the composer so you can review it first.

While recording you see a live level meter and elapsed time, and you can:

- **Stop** to transcribe and insert the transcript at your cursor.
- **Cancel** (`Esc` on web and desktop) to discard the recording.
- Toggle **Cleanup** for just this recording without changing the saved setting.

You can dictate at any time, including while the agent is working on a turn.

Recordings stop automatically at the 2 minute limit; the timer switches to a countdown near the end. The transcript from an auto-stopped recording is still inserted.

While a transcript is transcribing you can cancel the request. If transcription fails for a temporary reason (rate limit, model unavailable), the recording is kept and you can retry without re-recording.

Switching conversations or navigating elsewhere doesn't lose your words: the recording keeps going, and if the transcript finishes while you're somewhere else it's kept and inserted when you return to the conversation you dictated it for.

## Settings

Under **Settings → Voice Input** you can:

- Choose the voice model — a single audio-capable OpenRouter model handles both transcription and transcript cleanup. Only models that understand audio and text are listed, and you can enter a custom model ID.
- Set a spoken language, or leave it on automatic detection.
- Turn transcript cleanup on or off.
- Maintain a dictionary of names and terms (one per line) that transcription and cleanup should spell correctly.

## Troubleshooting

- **The microphone button asks to connect OpenRouter.** Voice Input needs a connected OpenRouter account; the button takes you to the right settings page.
- **Microphone permission was denied.** Re-enable microphone access for T3 Code (or your browser) in system settings, then try again.
- **"No speech was detected."** The recording contained no recognizable speech; nothing was inserted.
- **Transcription failed with a payment error.** OpenRouter requires account credit for transcription models; check your OpenRouter balance.
