# Voice input

Dictate a message instead of typing it. Voice input fills the composer; it never
sends anything by itself, so you can review and edit the text before sending.

Signed in to T3 Connect, voice input works in the web app, the desktop app, and
the mobile app, using your account's settings. Signed out, only supported
iPhones can dictate, on the device.

## Before you start

Open **Settings → Connections** and sign in to T3 Connect. The microphone then
appears in the composer. If it does not, the T3 Connect service you use has voice
input turned off. Mobile apps that are signed out, or whose service has voice input
off, fall back to [on-device dictation](#on-device-dictation-on-iphone).

The first recording asks for microphone access. If you declined, allow it in your
browser's site settings, or on macOS in **System Settings → Privacy & Security →
Microphone**, then try again.

## Dictate on web and desktop

- **Tap** the microphone to start, then click it again to transcribe.
- **Hold** the microphone to talk, and release to transcribe. Slide up before
  releasing to discard the recording.
- Press `mod+alt+v` to start or stop hands-free dictation. Change it under
  **Composer: Voice Input** in **Settings → Keybindings**.
- Press `Esc` to discard a recording.

The text goes where your cursor was when you started. If you switch threads while
transcribing, it is added to the draft of the thread you dictated into. You cannot
send that draft until transcription finishes.

A recording stops by itself at the clip limit, two minutes unless the service sets
another length; the composer counts down the last ten seconds. If transcription
fails for a temporary reason, use the retry button next to the microphone. Retrying
sends the same recording and is not counted twice.

## Dictate on mobile

Use the composer's microphone as usual. Signed in to T3 Connect, iPhone and Android
transcribe through your account, with the same language, cleanup, dictionary, and
daily allowance as on desktop. The recording stops at the clip limit.

## Settings

**Settings → Voice Input** on web and desktop holds settings that follow your T3
Connect account to every device:

- **Language**: the language you speak. **Automatic** detects it for each recording;
  choosing one helps with short clips and accents.
- **Clean up transcripts**: fixes punctuation and capitalization and drops filler
  words such as "um", without rewording what you said.
- **Dictionary**: names and terms to spell exactly, one per line, up to 200.

The same page shows how much of today's allowance you have used.

## Daily allowance

Each account can transcribe 30 minutes of audio per day unless the service sets
another amount. The allowance resets at midnight UTC. A recording counts for its
length; recordings in which no speech was found still count, and transcriptions that
fail on the service's side do not. When you reach the limit, T3 Code tells you when it
resets.

## Privacy

Recordings travel through T3 Connect to OpenRouter and on to the speech model
provider, Google Gemini by default, which return the text. T3 Connect does not store
audio. It keeps the resulting text for up to a day so a retried request returns the
same transcript, then deletes it. Daily usage totals are kept for a week. Your
settings are stored with your account until you change them.

## On-device dictation on iPhone

Without T3 Connect, iPhones with iOS 26 or later transcribe on the device. Use the
composer's microphone to record, then confirm to transcribe. The first use may
download Apple's speech model and needs a network connection; later transcription
works offline for that language. Recordings can be up to five minutes long.
On-device audio never leaves your phone.

## Microphones on iPhone

Canceling, leaving the screen, or an audio interruption discards the recording and
preserves your existing draft. While recording, the screen stays awake. T3 Code
deletes the temporary audio after transcription or cancellation.

Voice input records from the first connected microphone in **Settings → Microphone**.
The list mixes kinds (built-in, other wired, other Bluetooth, CarPlay) with wired and
Bluetooth devices you have dictated with, listed by name. Drag to rank them together:
for example, put **Other Bluetooth** above your AirPods so a new headset is preferred
while the AirPods microphone stays low. By default, CarPlay comes after the built-in
microphone.
