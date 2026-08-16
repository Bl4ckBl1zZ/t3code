# T3 Code Mobile

> [!WARNING]
> T3 Code Mobile is currently in development and is not distributed yet. If you want to try it out, you can build it from source.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `T3 Code Dev`
- `preview`: persistent internal preview build, installable side-by-side as `T3 Code Preview`
- `production`: store/release build as `T3 Code`

Run commands from `apps/mobile`.

T3 Connect is optional and disabled in a fresh clone. Public configuration belongs in the
repository-root `.env` or `.env.local`, not an `apps/mobile/.env` file. See
[`../../.env.example`](../../.env.example).

## Development

Start Metro for the dev client:

```bash
vp run dev:client
```

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

If your Xcode account only has a Personal Team, use a bundle identifier you control and opt into the
reduced-capability local build. Personal Team builds omit the widget and share extensions, push
entitlement, and native Sign in with Apple entitlement; builds without this opt-in are unchanged.

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev \
vp run ios:dev
```

Build and install a self-contained Release app that does not need Metro:

```bash
vp run ios:release
```

The Personal Team equivalent also needs a unique bundle identifier:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
vp run ios:release
```

For a managed development profile that includes push notifications and widgets, keep Personal Team
mode off and supply the registered identifiers explicitly:

```bash
APP_VARIANT=production \
T3CODE_IOS_BUNDLE_ID=com.example.t3code.dev \
T3CODE_IOS_APP_GROUP_ID=group.com.example.t3code.dev \
T3CODE_IOS_APPLE_TEAM_ID=ABCDE12345 \
T3CODE_IOS_APNS_ENVIRONMENT=sandbox \
T3CODE_IOS_ASSOCIATED_DOMAINS=0 \
T3CODE_IOS_SHARING_EXTENSION=0 \
vp run ios:release
```

Set `T3CODE_IOS_ASSOCIATED_DOMAINS=0` only when the main provisioning profile does not include the
Associated Domains capability.

Set `T3CODE_IOS_SHARING_EXTENSION=1` only after provisioning the separate
`<bundle-identifier>.sharing` extension.

For a local development archive with manually downloaded profiles, also set
`T3CODE_IOS_PROVISIONING_PROFILE` and `T3CODE_IOS_WIDGETS_PROVISIONING_PROFILE` to the main app and
widget profile names. Both require `T3CODE_IOS_APPLE_TEAM_ID`.

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Force the review diff highlighter engine:

```bash
EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=javascript vp run ios:dev
```

`javascript` is the default and recommended setting for the review diff screen. Set `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when you explicitly want to test the native Shiki engine.

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## Releasing to TestFlight

Production iOS releases do not go through EAS. `.github/workflows/mobile-ios-testflight.yml`
runs `expo prebuild` → `xcodebuild archive` → `exportArchive` → upload, on every push to `main`.
Expo the framework is still doing the work — every config plugin runs during prebuild — but Expo's
servers are not in the loop. (`mobile-eas-production.yml` remains as a manual-only fallback.)

EAS Update is unaffected: it is a separate service from EAS Build, so OTA updates still publish to
the same channel as long as `EXPO_PROJECT_ID` stays set.

Run the same pipeline from a Mac with Xcode installed:

```bash
export APPLE_DISTRIBUTION_P12=~/.t3/signing/t3code/dist.p12
export APPLE_DISTRIBUTION_P12_PASSWORD=...
export APPLE_MAIN_PROFILE=~/.t3/signing/t3code/T3_Code_App_Store.mobileprovision
export APPLE_WIDGETS_PROFILE=~/.t3/signing/t3code/T3_Code_Widgets_App_Store.mobileprovision
export APPLE_SHARING_PROFILE=~/.t3/signing/t3code/T3_Code_Sharing_App_Store.mobileprovision
export ASC_API_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8
export ASC_API_KEY_ID=XXXXXXXXXX ASC_API_ISSUER_ID=... ASC_APP_ID=6796384276

vp run ios:testflight            # add SKIP_UPLOAD=1 to stop after the export
```

Team, bundle identifier, App Group and profile names are **read out of the provisioning profiles**
rather than configured — the App Group (`group.com.bl4ckbl1zz.t3code.dev`) is not derivable from the
bundle identifier (`com.t3code.dev`), so anything that reconstructs it by convention is wrong. The
build number comes from App Store Connect (highest existing, plus one); pass
`T3CODE_IOS_BUILD_NUMBER` to override.

Before archiving, the script asserts that the resolved Expo config carries a Clerk publishable key
and a relay URL. Those used to arrive from the EAS hosted environment; missing, they do not fail the
build, they ship a TestFlight binary that cannot sign in. CI supplies them from the `production`
environment's `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`, and `RELAY_DOMAIN` variables, alongside
these secrets:

| Secret                                                              | Purpose                        |
| ------------------------------------------------------------------- | ------------------------------ |
| `APPLE_DISTRIBUTION_P12_BASE64` / `APPLE_DISTRIBUTION_P12_PASSWORD` | Apple Distribution certificate |
| `APPLE_MAIN_APPSTORE_PROFILE_BASE64`                                | App Store profile for the app  |
| `APPLE_WIDGETS_APPSTORE_PROFILE_BASE64`                             | ... for the widgets extension  |
| `APPLE_SHARING_APPSTORE_PROFILE_BASE64`                             | ... for the sharing extension  |
| `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER`           | App Store Connect API key      |

## EAS Builds

CI uses Expo fingerprinting with the `preview:dev` profile to reuse an existing compatible build when possible, or start a new internal EAS build when native runtime inputs change. Production and default local builds continue to use the `appVersion` runtime policy.

For preview or production EAS environments, set `T3CODE_CLERK_PUBLISHABLE_KEY`,
`T3CODE_CLERK_JWT_TEMPLATE`, and `T3CODE_RELAY_URL`
as EAS environment variables. Expo config maps the canonical values into the mobile build.

Create a PR preview dev-client build manually:

```bash
vp run eas:ios:preview:dev
```

Create a cloud dev-client build:

```bash
vp run eas:ios:dev
```

Create a persistent preview build:

```bash
vp run eas:ios:preview
```

Android equivalents:

```bash
vp run eas:android:dev
vp run eas:android:preview:dev
vp run eas:android:preview
```
