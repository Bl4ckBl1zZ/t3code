# Relay voice input

> For maintainers. Using T3 Code? See [Voice input](../user/voice-input.md).

The relay transcribes voice input for signed-in T3 Connect accounts with one
OpenRouter key that the operator pays for. Users never bring their own key. Voice
input stays off until the key is configured, and clients hide the microphone (mobile
falls back to on-device dictation) while it is off.

## Turn it on

1. Create an OpenRouter API key for the relay. In OpenRouter, give that key a
   **credit limit**. The relay's caps bound normal use; the key limit is the backstop
   if a cap is misconfigured or the relay misbehaves.
2. Add it as the `OPENROUTER_API_KEY` repository secret for the
   [Deploy Relay workflow](../../.github/workflows/deploy-relay.yml), or set it in
   `infra/relay/.env` for a manual deploy. Leaving it unset deploys with voice off.
3. Optionally set the variables below as repository variables (or in
   `infra/relay/.env`), then deploy. Blank values use the defaults.

## Variables

| Variable                       | Default                   | Meaning                                                                                                                                       |
| ------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `VOICE_INPUT_ENABLED`          | `true`                    | Kill switch. `false` turns voice off for everyone without removing the key; settings and usage are kept.                                      |
| `VOICE_INPUT_MODEL`            | `google/gemini-2.5-flash` | OpenRouter model. Allowed: `google/gemini-2.5-flash`, `google/gemini-2.5-flash-lite`, `google/gemini-2.5-pro`, `openai/gpt-4o-audio-preview`. |
| `VOICE_INPUT_DAILY_SECONDS`    | `1800`                    | Audio seconds each account may transcribe per UTC day.                                                                                        |
| `VOICE_INPUT_MAX_CLIP_SECONDS` | `120`                     | Longest single recording. Clients stop recording at this length.                                                                              |
| `VOICE_INPUT_MAX_UPLOAD_BYTES` | `10485760`                | Largest decoded upload.                                                                                                                       |

A value outside the allowlist or a non-positive number fails the deploy instead of
running with a surprising setting. Changing a variable takes effect on the next deploy.

## How the caps hold

- Seconds are reserved against the account's daily total in Postgres before OpenRouter
  is called, in one statement, so parallel requests cannot overshoot the cap. A failed
  OpenRouter call refunds them; a clip with no speech does not.
- WAV clips from web and desktop are billed by the length in their header. Compressed
  mobile clips are billed by the length the client reports, which the clip limit bounds.
- Each request carries a client request id. A retry with the same id returns the stored
  transcript without calling OpenRouter or counting again.
- The relay's scheduled cleanup deletes stored transcripts after 24 hours and usage rows
  after 7 days.

## Checking on it

Voice spans start with `relay.voice.`. `relay.voice.transcribe` records the audio format,
the reported and billed seconds, and the upload size. An OpenRouter `401`, `402`, or `403`
is logged as an error ("OpenRouter rejected the relay's voice key") and reaches users as
"Voice input is unavailable right now." That usually means the key was revoked or its
credit limit was reached. See [Relay observability](./relay-observability.md) for where
logs live.

## Upgrading from the fork

The migration that adds daily usage drops `relay_account_integrations`, where the fork
stored users' own OpenRouter keys, and the deploy no longer creates the voice credential
encryption key. Users' language, dictionary, and cleanup settings carry over.
