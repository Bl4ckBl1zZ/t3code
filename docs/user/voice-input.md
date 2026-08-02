# Voice Input

Dictate prompts instead of typing them. Voice Input records from your microphone, transcribes the audio, optionally cleans up filler words and punctuation, and inserts the result into the composer at your cursor.

Voice Input is available in the chat composer on web, desktop, and mobile.

## Requirements

- Sign in to T3 Connect.
- Connect an OpenRouter account under **Settings → Integrations → OpenRouter**. Your API key is validated when you save it, encrypted at rest, and never returned to clients. Audio and transcripts are processed by OpenRouter and the upstream model providers you select.

## Recording

Tap the microphone button in the composer (or press `⌘⇧M` / `Ctrl⇧M` on web and desktop) to start recording. While recording you see a live level meter and elapsed time, and you can:

- **Stop** to transcribe and insert the transcript at your cursor.
- **Cancel** (`Esc` on web and desktop) to discard the recording.
- Toggle **Cleanup** for just this recording without changing the saved setting.

Recordings stop automatically at the 2 minute limit; the timer switches to a countdown near the end. The transcript from an auto-stopped recording is still inserted.

While a transcript is transcribing you can cancel the request. If transcription fails for a temporary reason (rate limit, model unavailable), the recording is kept and you can retry without re-recording.

## After inserting

The composer shows what happened and offers one-tap recovery:

- **Use raw** swaps the cleaned-up transcript for the exact words you said.
- **Undo** removes the insertion entirely.

Editing the prompt dismisses these options.

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
