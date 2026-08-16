#!/usr/bin/env bash

# Builds the native SwiftUI client and ships it to TestFlight:
# xcodebuild archive -> exportArchive -> altool upload.
#
# This replaces apps/mobile/scripts/ios-testflight.sh, which had to run
# `expo prebuild` first to generate an Xcode project. This project is the
# source of truth, so the prebuild and CocoaPods steps are simply gone --
# along with their failure modes (a stale ios/ shipping the wrong entitlements,
# `pod install` failing while prebuild still exits 0, the CocoaPods locale
# crash).
#
# Everything else is deliberately unchanged from the React Native pipeline:
# identity is read out of the provisioning profiles rather than configured, the
# build number comes from App Store Connect, and signing material lives in a
# throwaway keychain deleted on exit. scripts/lib/ios-release.ts holds that
# logic and is covered by scripts/lib/ios-release.test.ts.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${app_dir}/../.." && pwd)"

output_dir="${app_dir}/build"
archive_path="${output_dir}/T3Code.xcarchive"
export_dir="${output_dir}/export"

log() { printf '\n[testflight] %s\n' "$*"; }
die() { printf '[testflight] error: %s\n' "$*" >&2; exit 1; }

require_env() {
  for name in "$@"; do
    [ -n "${!name:-}" ] || die "missing required environment variable: ${name}"
  done
}

require_env \
  APPLE_DISTRIBUTION_P12 APPLE_DISTRIBUTION_P12_PASSWORD \
  APPLE_MAIN_PROFILE APPLE_WIDGETS_PROFILE APPLE_SHARING_PROFILE \
  ASC_API_KEY_PATH ASC_API_KEY_ID ASC_API_ISSUER_ID

# T3 Connect is compiled in, not fetched at runtime. Missing values do not fail
# the build -- they ship a binary that cannot sign in -- so assert them here.
require_env T3CODE_CLERK_PUBLISHABLE_KEY T3CODE_RELAY_URL
case "${T3CODE_RELAY_URL}" in
  https://*) ;;
  *) die "T3CODE_RELAY_URL must use HTTPS (got ${T3CODE_RELAY_URL})" ;;
esac

mkdir -p "${output_dir}"

log "Resolving identity from the provisioning profiles"
# Team, bundle identifiers, App Group and profile names are read out of the
# profiles rather than configured. The App Group
# (group.com.bl4ckbl1zz.t3code.dev) is not derivable from the bundle identifier
# (com.t3code.dev), so anything reconstructing it by convention is wrong.
identity="$(node "${repo_root}/scripts/ios-release.ts" identity \
  --app "${APPLE_MAIN_PROFILE}" \
  --widgets "${APPLE_WIDGETS_PROFILE}" \
  --sharing "${APPLE_SHARING_PROFILE}" \
  ${T3CODE_IOS_BUILD_NUMBER:+--build-number "${T3CODE_IOS_BUILD_NUMBER}"})"
# export-options later reads these from the environment, so export rather
# than just assign.
set -a
eval "${identity}"
set +a

require_env \
  T3CODE_IOS_APPLE_TEAM_ID T3CODE_IOS_BUNDLE_ID T3CODE_IOS_BUILD_NUMBER \
  T3CODE_IOS_PROVISIONING_PROFILE T3CODE_IOS_WIDGETS_PROVISIONING_PROFILE \
  T3CODE_IOS_SHARING_PROVISIONING_PROFILE \
  T3CODE_IOS_PROFILE_UUID_APP T3CODE_IOS_PROFILE_UUID_WIDGETS \
  T3CODE_IOS_PROFILE_UUID_SHARING

[ "${T3CODE_IOS_BUNDLE_ID}" = "com.t3code.dev" ] || die \
  "the distribution profile is for ${T3CODE_IOS_BUNDLE_ID}, not com.t3code.dev"

log "Installing signing material"
keychain_path="${output_dir}/t3code-signing.keychain-db"
keychain_password="$(uuidgen)"
security create-keychain -p "${keychain_password}" "${keychain_path}"
security set-keychain-settings -lut 3600 "${keychain_path}"
security unlock-keychain -p "${keychain_password}" "${keychain_path}"
security import "${APPLE_DISTRIBUTION_P12}" \
  -k "${keychain_path}" \
  -P "${APPLE_DISTRIBUTION_P12_PASSWORD}" \
  -T /usr/bin/codesign \
  -T /usr/bin/security
# -T alone is not enough on modern macOS; the partition list is what actually
# stops the keychain prompting for permission on first use.
security set-key-partition-list -S apple-tool:,apple: -s -k "${keychain_password}" "${keychain_path}" >/dev/null
existing_keychains="$(security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"$//')"
# shellcheck disable=SC2086
security list-keychains -d user -s "${keychain_path}" ${existing_keychains}

# Xcode looks profiles up by UUID filename, not by path. `identity` already
# parsed each profile, so reuse the UUIDs it reported.
profiles_dir="${HOME}/Library/MobileDevice/Provisioning Profiles"
mkdir -p "${profiles_dir}"
cp "${APPLE_MAIN_PROFILE}" "${profiles_dir}/${T3CODE_IOS_PROFILE_UUID_APP}.mobileprovision"
cp "${APPLE_WIDGETS_PROFILE}" "${profiles_dir}/${T3CODE_IOS_PROFILE_UUID_WIDGETS}.mobileprovision"
cp "${APPLE_SHARING_PROFILE}" "${profiles_dir}/${T3CODE_IOS_PROFILE_UUID_SHARING}.mobileprovision"

cleanup() {
  security delete-keychain "${keychain_path}" 2>/dev/null || true
}
trap cleanup EXIT

log "Archiving T3Code (build ${T3CODE_IOS_BUILD_NUMBER})"
rm -rf "${archive_path}" "${export_dir}"
# Each target needs its own profile, so the specifier cannot be a global
# command-line setting. The Release configs read per-target
# T3CODE_PROFILE_* build settings supplied here instead. There is no Pods
# project, so CODE_SIGN_STYLE and the identity are safe to set globally.
xcodebuild archive \
  -project "${app_dir}/T3Code.xcodeproj" \
  -scheme T3Code \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "${archive_path}" \
  -quiet \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="Apple Distribution" \
  DEVELOPMENT_TEAM="${T3CODE_IOS_APPLE_TEAM_ID}" \
  OTHER_CODE_SIGN_FLAGS="--keychain ${keychain_path}" \
  CURRENT_PROJECT_VERSION="${T3CODE_IOS_BUILD_NUMBER}" \
  ${T3CODE_IOS_MARKETING_VERSION:+MARKETING_VERSION="${T3CODE_IOS_MARKETING_VERSION}"} \
  T3CODE_PROFILE_APP="${T3CODE_IOS_PROVISIONING_PROFILE}" \
  T3CODE_PROFILE_WIDGETS="${T3CODE_IOS_WIDGETS_PROVISIONING_PROFILE}" \
  T3CODE_PROFILE_SHARING="${T3CODE_IOS_SHARING_PROVISIONING_PROFILE}" \
  T3CODE_CLERK_PUBLISHABLE_KEY="${T3CODE_CLERK_PUBLISHABLE_KEY}" \
  T3CODE_CLERK_JWT_TEMPLATE="${T3CODE_CLERK_JWT_TEMPLATE:-t3-relay}" \
  T3CODE_RELAY_URL="${T3CODE_RELAY_URL}"

log "Exporting the archive"
export_options="${output_dir}/ExportOptions.plist"
node "${repo_root}/scripts/ios-release.ts" export-options "${export_options}"

xcodebuild -exportArchive \
  -archivePath "${archive_path}" \
  -exportOptionsPlist "${export_options}" \
  -exportPath "${export_dir}" \
  -quiet

ipa_path="$(find "${export_dir}" -maxdepth 1 -name '*.ipa' -print -quit)"
[ -n "${ipa_path}" ] || die "exportArchive produced no .ipa."
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
