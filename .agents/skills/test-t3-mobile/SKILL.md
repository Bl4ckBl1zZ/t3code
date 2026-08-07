---
name: test-t3-mobile
description: Launch and test the native SwiftUI T3 Code iOS client on a Simulator against disposable local T3 environments, including build, pairing by deep link, semantic UI control, and screenshots. Use after iOS UI or native changes, when reproducing phone or tablet behavior, or verifying mobile behavior on macOS.
---

# Test T3 Code on iOS

Run one focused, end-to-end verification pass against disposable T3 state.

The mobile client is the **native SwiftUI app in `apps/swift-ios`**. It has no
JavaScript runtime: there is no Metro, no Expo, no dev client, and no bundler to
keep alive between runs. Every change requires a rebuild.

`apps/mobile` is the retired React Native client. It has no build pipeline and
is being removed — do not build, run, or verify against it.

## Build and run

Requires macOS with Xcode. The repo pins Xcode via `DEVELOPER_DIR` in
`.mcp.json`; `xcode-select` may point elsewhere, so set it explicitly:

```sh
export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
```

Use the `ios-debugger-agent` skill for the actual build/launch/UI-automation
loop. Its XcodeBuildMCP session defaults are:

- **Project** `apps/swift-ios/T3Code.xcodeproj` (a project, not a workspace)
- **Scheme** `T3Code`
- **Configuration** `Debug`
- **Bundle identifier** `com.t3code.dev.debug`
- **URL scheme** `t3code-debug`

Release builds as `com.t3code.dev` with scheme `t3code` — that is the shipped
identity, and a local Debug build installs beside it rather than replacing it.

## Tests

```sh
./apps/swift-ios/Scripts/ci-test.sh
```

Picks an available iPhone from the newest installed runtime. Pin one with
`T3_SWIFT_SIMULATOR_ID=<udid>` when the auto-pick lands on a device the image
has dropped.

## Pairing

Stand up disposable server state with the `test-t3-app` skill, then open the
pairing deep link on the booted simulator:

```sh
xcrun simctl openurl booted "t3code-debug://connections/new"
```

Paste or deep-link the pairing URL the server prints. Credentials land in the
Keychain; saved servers land in Application Support under `T3CodeSwift/`.

## What to check after a contract change

The Swift client mirrors `packages/contracts` **by hand** — a schema change
compiles fine and fails at runtime. After changing a contract:

```sh
node scripts/generate-swift-contract-fixtures.ts     # regenerate
./apps/swift-ios/Scripts/ci-test.sh                  # decode tests
```

CI runs the `--check` form, so a stale fixture fails there rather than on a
user's phone.
