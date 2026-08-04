#!/usr/bin/env bash
#
# Builds the production iOS app and ships it to TestFlight, with no dependency on
# Expo's servers: prebuild -> xcodebuild archive -> exportArchive -> upload.
#
# Expo the framework is still very much in use (this runs `expo prebuild`, which
# applies every config plugin). What is gone is EAS the service — its build
# sandbox, its remote build-number counter, and its submit wrapper.
#
# Runs identically on a developer Mac and on a CI runner. Inputs are paths and
# ids, never repository variables that could drift from what Apple issued:
#
#   APPLE_DISTRIBUTION_P12        Apple Distribution certificate (.p12)
#   APPLE_DISTRIBUTION_P12_PASSWORD
#   APPLE_MAIN_PROFILE            App Store .mobileprovision for the app
#   APPLE_WIDGETS_PROFILE         ... for the widgets extension
#   APPLE_SHARING_PROFILE         ... for the sharing extension (optional)
#   ASC_API_KEY_PATH              App Store Connect API key (.p8)
#   ASC_API_KEY_ID
#   ASC_API_ISSUER_ID
#   ASC_APP_ID                    Numeric App Store Connect app id
#
# Optional:
#   T3CODE_IOS_BUILD_NUMBER       Skip the App Store Connect lookup
#   SKIP_UPLOAD=1                 Archive and export only
#   IOS_OUTPUT_DIR                Defaults to apps/mobile/build
set -euo pipefail

mobile_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${mobile_dir}/../.." && pwd)"
output_dir="${IOS_OUTPUT_DIR:-${mobile_dir}/build}"
archive_path="${output_dir}/T3Code.xcarchive"
export_dir="${output_dir}/export"

log() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

require_file() {
  [ -f "$1" ] || { echo "Missing required file: $1 ($2)" >&2; exit 1; }
}

require_file "${APPLE_DISTRIBUTION_P12:-}" APPLE_DISTRIBUTION_P12
require_file "${APPLE_MAIN_PROFILE:-}" APPLE_MAIN_PROFILE
require_file "${APPLE_WIDGETS_PROFILE:-}" APPLE_WIDGETS_PROFILE
# Only needed to look up the next build number and to upload. A local
# archive-only run needs neither, and should not have to hold an API key.
if [ -z "${T3CODE_IOS_BUILD_NUMBER:-}" ] || [ "${SKIP_UPLOAD:-}" != "1" ]; then
  require_file "${ASC_API_KEY_PATH:-}" ASC_API_KEY_PATH
fi

log "Resolving signing identity from the provisioning profiles"
# Team, bundle id, App Group and profile names all come out of the profiles
# themselves. The App Group in particular is not derivable from the bundle id,
# so reconstructing it from convention would be silently wrong.
identity_args=(--app "${APPLE_MAIN_PROFILE}" --widgets "${APPLE_WIDGETS_PROFILE}")
if [ -n "${APPLE_SHARING_PROFILE:-}" ] && [ -f "${APPLE_SHARING_PROFILE}" ]; then
  identity_args+=(--sharing "${APPLE_SHARING_PROFILE}")
fi
if [ -n "${T3CODE_IOS_BUILD_NUMBER:-}" ]; then
  identity_args+=(--build-number "${T3CODE_IOS_BUILD_NUMBER}")
fi
identity="$(node "${repo_root}/scripts/ios-release.ts" identity "${identity_args[@]}")"
eval "${identity}"
export T3CODE_IOS_APPLE_TEAM_ID T3CODE_IOS_BUNDLE_ID T3CODE_IOS_APP_GROUP_ID \
  T3CODE_IOS_BUILD_NUMBER T3CODE_IOS_PROVISIONING_PROFILE \
  T3CODE_IOS_WIDGETS_PROVISIONING_PROFILE T3CODE_IOS_SHARING_EXTENSION
[ -n "${T3CODE_IOS_SHARING_PROVISIONING_PROFILE:-}" ] &&
  export T3CODE_IOS_SHARING_PROVISIONING_PROFILE
export APP_VARIANT=production
export T3CODE_IOS_SIGNING_IDENTITY="Apple Distribution"
echo "Build ${T3CODE_IOS_BUNDLE_ID} (${T3CODE_IOS_APPLE_TEAM_ID}) #${T3CODE_IOS_BUILD_NUMBER}"

log "Installing provisioning profiles"
# Xcode resolves PROVISIONING_PROFILE_SPECIFIER by scanning this directory, and
# only accepts profiles filed under their own UUID.
profiles_dir="${HOME}/Library/MobileDevice/Provisioning Profiles"
mkdir -p "${profiles_dir}"
cp "${APPLE_MAIN_PROFILE}" "${profiles_dir}/${T3CODE_IOS_PROFILE_UUID_APP}.mobileprovision"
cp "${APPLE_WIDGETS_PROFILE}" "${profiles_dir}/${T3CODE_IOS_PROFILE_UUID_WIDGETS}.mobileprovision"
if [ -n "${T3CODE_IOS_PROFILE_UUID_SHARING:-}" ]; then
  cp "${APPLE_SHARING_PROFILE}" "${profiles_dir}/${T3CODE_IOS_PROFILE_UUID_SHARING}.mobileprovision"
fi

log "Importing the distribution certificate"
# A dedicated keychain rather than the login one: on CI there is no login
# keychain worth touching, and on a developer Mac this must not add a CI cert to
# the keychain the user actually uses.
keychain_path="${output_dir}/t3code-signing.keychain-db"
keychain_password="$(uuidgen)"
mkdir -p "${output_dir}"
rm -f "${keychain_path}"
security create-keychain -p "${keychain_password}" "${keychain_path}"
# Without a timeout an unattended build can hit the default 5-minute auto-lock
# mid-archive, and codesign then fails with a bare "User interaction is not
# allowed".
security set-keychain-settings -lut 21600 "${keychain_path}"
security unlock-keychain -p "${keychain_password}" "${keychain_path}"
security import "${APPLE_DISTRIBUTION_P12}" \
  -k "${keychain_path}" \
  -P "${APPLE_DISTRIBUTION_P12_PASSWORD:-}" \
  -T /usr/bin/codesign \
  -T /usr/bin/security
# -T alone is not enough on modern macOS; the partition list is what actually
# stops the keychain prompting for permission on first use.
security set-key-partition-list -S apple-tool:,apple: -s -k "${keychain_password}" "${keychain_path}" >/dev/null
existing_keychains="$(security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"$//')"
# shellcheck disable=SC2086
security list-keychains -d user -s "${keychain_path}" ${existing_keychains}

cleanup() {
  security delete-keychain "${keychain_path}" 2>/dev/null || true
}
trap cleanup EXIT

cd "${mobile_dir}"

log "Checking the resolved app config"
# Under EAS these values arrived from the hosted "production" environment. A
# direct build has to supply them itself, and a missing Clerk key does not fail
# the build — it ships a TestFlight binary that cannot sign in.
node "${repo_root}/scripts/ios-release.ts" check-config \
  "$(pnpm exec expo config --type public --json)"

log "Generating the native iOS project"
# CocoaPods normalizes the installation root as Unicode, which raises
# `Encoding::CompatibilityError` when the locale leaves Ruby's strings tagged
# ASCII-8BIT — a plain `pod install` failure with a stack trace and no mention
# of locale. CI images happen to set this; a developer shell often does not.
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
# --clean: a stale ios/ predating a config change is the classic source of a
# build that succeeds locally and ships the wrong entitlements.
EXPO_NO_GIT_STATUS=1 pnpm exec expo prebuild --clean --platform ios

# Unlike the EAS sandbox, this shell's env reaches prebuild, so every target
# bakes the same build number without the "sync extension build number" dance
# the EAS pipeline needed. Verify rather than assume: a mismatch here is
# otherwise reported by Xcode at the very end of the archive.
node "${repo_root}/scripts/ios-release.ts" check-build-number "${T3CODE_IOS_BUILD_NUMBER}" \
  ios/*/Info.plist

workspace="$(find ios -maxdepth 1 -name '*.xcworkspace' -print -quit)"
# `expo prebuild` exits 0 even when its `pod install` fails, so the missing
# workspace is the only reliable signal that it did.
[ -n "${workspace}" ] || {
  echo "expo prebuild produced no Xcode workspace — 'pod install' failed above." >&2
  exit 1
}
scheme="$(basename "${workspace}" .xcworkspace)"

log "Archiving ${scheme}"
rm -rf "${archive_path}" "${export_dir}"
# Signing settings are deliberately NOT passed here. An xcodebuild command-line
# setting is global, and the Pods project contains ~80 static libraries and
# resource bundles that must not be signed at all — forcing CODE_SIGNING_ALLOWED
# on them fails the archive with "an empty code signing identity is not valid".
# The three app targets already carry per-target manual signing, applied to the
# project by plugins/withIosManualSigning.cjs.
xcodebuild archive \
  -workspace "${workspace}" \
  -scheme "${scheme}" \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "${archive_path}" \
  -quiet \
  OTHER_CODE_SIGN_FLAGS="--keychain ${keychain_path}"

log "Exporting the archive"
export_options="${output_dir}/ExportOptions.plist"
node "${repo_root}/scripts/ios-release.ts" export-options "${export_options}"

xcodebuild -exportArchive \
  -archivePath "${archive_path}" \
  -exportOptionsPlist "${export_options}" \
  -exportPath "${export_dir}" \
  -quiet

ipa_path="$(find "${export_dir}" -maxdepth 1 -name '*.ipa' -print -quit)"
[ -n "${ipa_path}" ] || { echo "exportArchive produced no .ipa." >&2; exit 1; }
echo "Exported ${ipa_path}"

if [ "${SKIP_UPLOAD:-}" = "1" ]; then
  log "SKIP_UPLOAD=1 — stopping before TestFlight"
  exit 0
fi

log "Uploading to TestFlight"
# altool finds the key by id in one of a few fixed directories rather than by
# path, so place it where it looks.
private_keys_dir="${HOME}/.appstoreconnect/private_keys"
mkdir -p "${private_keys_dir}"
cp "${ASC_API_KEY_PATH}" "${private_keys_dir}/AuthKey_${ASC_API_KEY_ID}.p8"

# Validate first: a duplicate build number is rejected here in seconds, rather
# than after uploading the whole binary.
xcrun altool --validate-app \
  --file "${ipa_path}" \
  --type ios \
  --apiKey "${ASC_API_KEY_ID}" \
  --apiIssuer "${ASC_API_ISSUER_ID}"

xcrun altool --upload-app \
  --file "${ipa_path}" \
  --type ios \
  --apiKey "${ASC_API_KEY_ID}" \
  --apiIssuer "${ASC_API_ISSUER_ID}"

log "Uploaded build ${T3CODE_IOS_BUILD_NUMBER} to TestFlight"
