import type { ExpoConfig } from "expo/config";

import { BRAND_ASSET_PATHS } from "../../scripts/lib/brand-assets.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

type AppVariant = "development" | "preview" | "production";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

const APP_VARIANT = resolveAppVariant(repoEnv.APP_VARIANT);
const isIosPersonalTeamBuild = repoEnv.T3CODE_IOS_PERSONAL_TEAM === "1";

const personalTeamBundleIdentifier = repoEnv.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID?.trim();
const managedIosBundleIdentifier = repoEnv.T3CODE_IOS_BUNDLE_ID?.trim();
const managedIosAppGroupIdentifier = repoEnv.T3CODE_IOS_APP_GROUP_ID?.trim();
const managedIosAppleTeamId = repoEnv.T3CODE_IOS_APPLE_TEAM_ID?.trim();
const managedIosBuildNumber = repoEnv.T3CODE_IOS_BUILD_NUMBER?.trim();
const managedIosProvisioningProfile = repoEnv.T3CODE_IOS_PROVISIONING_PROFILE?.trim();
const managedIosWidgetsProvisioningProfile =
  repoEnv.T3CODE_IOS_WIDGETS_PROVISIONING_PROFILE?.trim();
const managedIosSharingProvisioningProfile =
  repoEnv.T3CODE_IOS_SHARING_PROVISIONING_PROFILE?.trim();
// "Apple Development" for a local archive, "Apple Distribution" for App Store
// releases. Signing an App Store archive with the development identity fails at
// export with an opaque profile mismatch, so the release pipeline sets this.
const managedIosSigningIdentity =
  repoEnv.T3CODE_IOS_SIGNING_IDENTITY?.trim() || "Apple Development";
const expoProjectId = repoEnv.T3CODE_EXPO_PROJECT_ID?.trim();
const expoOwner = repoEnv.T3CODE_EXPO_OWNER?.trim();
const isIosManualSigningEnabled =
  Boolean(managedIosProvisioningProfile) || Boolean(managedIosWidgetsProvisioningProfile);
const isIosSharingExtensionEnabled =
  !isIosPersonalTeamBuild && repoEnv.T3CODE_IOS_SHARING_EXTENSION !== "0";
const isIosAssociatedDomainsEnabled =
  !isIosPersonalTeamBuild && repoEnv.T3CODE_IOS_ASSOCIATED_DOMAINS !== "0";
const iosNotificationsMode =
  repoEnv.T3CODE_IOS_APNS_ENVIRONMENT === "sandbox"
    ? "development"
    : APP_VARIANT === "development"
      ? "development"
      : "production";
const IOS_BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const IOS_APP_GROUP_IDENTIFIER_PATTERN = /^group\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const IOS_APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;
const IOS_DEPLOYMENT_TARGET = "18.0";

const fromRepoRoot = (relativePath: string) => `../../${relativePath}`;

if (
  isIosPersonalTeamBuild &&
  (!personalTeamBundleIdentifier ||
    !IOS_BUNDLE_IDENTIFIER_PATTERN.test(personalTeamBundleIdentifier))
) {
  throw new Error(
    "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID must be a reverse-DNS identifier such as com.example.t3code when T3CODE_IOS_PERSONAL_TEAM=1.",
  );
}

if (managedIosBundleIdentifier && !IOS_BUNDLE_IDENTIFIER_PATTERN.test(managedIosBundleIdentifier)) {
  throw new Error(
    "T3CODE_IOS_BUNDLE_ID must be a reverse-DNS identifier such as com.example.t3code.",
  );
}

if (
  managedIosAppGroupIdentifier &&
  !IOS_APP_GROUP_IDENTIFIER_PATTERN.test(managedIosAppGroupIdentifier)
) {
  throw new Error(
    "T3CODE_IOS_APP_GROUP_ID must be an App Group identifier such as group.com.example.t3code.",
  );
}

if (managedIosAppleTeamId && !IOS_APPLE_TEAM_ID_PATTERN.test(managedIosAppleTeamId)) {
  throw new Error("T3CODE_IOS_APPLE_TEAM_ID must be a 10-character Apple Team ID.");
}

if (
  isIosManualSigningEnabled &&
  (!managedIosAppleTeamId ||
    !managedIosProvisioningProfile ||
    !managedIosWidgetsProvisioningProfile)
) {
  throw new Error(
    "Manual iOS signing requires T3CODE_IOS_APPLE_TEAM_ID, T3CODE_IOS_PROVISIONING_PROFILE, and T3CODE_IOS_WIDGETS_PROVISIONING_PROFILE.",
  );
}

const DEVELOPMENT_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIosIconPng),
  androidAdaptiveForeground: fromRepoRoot(BRAND_ASSET_PATHS.developmentUniversalIconPng),
  androidAdaptiveBackgroundColor: "#00639B",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#00639B",
} as const;

const PREVIEW_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIosIconPng),
  androidAdaptiveForeground: fromRepoRoot(BRAND_ASSET_PATHS.nightlyLinuxIconPng),
  androidAdaptiveBackgroundColor: "#111533",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#7565C7",
} as const;

const RELEASE_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng),
  androidAdaptiveForeground: "./assets/android-icon-mark.png",
  androidAdaptiveBackgroundColor: "#000000",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#FFFFFF",
} as const;

const VARIANT_CONFIG = {
  development: {
    appName: "T3 Code Dev",
    scheme: "t3code-dev",
    iosBundleIdentifier: "com.t3tools.t3code.dev",
    androidPackage: "com.t3tools.t3code.dev",
    relyingParty: "clerk.t3.codes",
    assets: DEVELOPMENT_ASSETS,
  },
  preview: {
    appName: "T3 Code Preview",
    scheme: "t3code-preview",
    iosBundleIdentifier: "com.t3tools.t3code.preview",
    androidPackage: "com.t3tools.t3code.preview",
    relyingParty: "clerk.t3.codes",
    assets: PREVIEW_ASSETS,
  },
  production: {
    appName: "T3 Code",
    scheme: "t3code",
    iosBundleIdentifier: "com.t3tools.t3code",
    androidPackage: "com.t3tools.t3code",
    relyingParty: "clerk.t3.codes",
    assets: RELEASE_ASSETS,
  },
} as const;

function resolveAppVariant(value: string | undefined): AppVariant {
  switch (value) {
    case "development":
    case "preview":
    case "production":
      return value;
    default:
      return "production";
  }
}

const variant = VARIANT_CONFIG[APP_VARIANT];
const iosBundleIdentifier = isIosPersonalTeamBuild
  ? personalTeamBundleIdentifier!
  : (managedIosBundleIdentifier ?? variant.iosBundleIdentifier);
const iosAppGroupIdentifier = managedIosAppGroupIdentifier ?? `group.${iosBundleIdentifier}`;

const dmSansFonts = {
  regular: "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf",
  medium: "@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf",
  bold: "@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf",
} as const;

const widgetsPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-widgets",
  {
    bundleIdentifier: `${iosBundleIdentifier}.widgets`,
    groupIdentifier: iosAppGroupIdentifier,
    enablePushNotifications: true,
    // Agent activity can update many times an hour; without the
    // frequent-updates entitlement iOS throttles the update budget sooner.
    frequentUpdates: true,
    widgets: [
      {
        name: "AgentActivity",
        displayName: "Agent Activity",
        description: "Shows the current state of active T3 Code agents.",
        supportedFamilies: ["systemSmall", "systemMedium", "accessoryRectangular"],
      },
    ],
  },
];

const sharingPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-sharing",
  {
    ios: {
      // Personal Teams cannot sign App Groups or extension targets. Keep the
      // reduced-capability local build usable while release builds expose the
      // real system share target.
      enabled: isIosSharingExtensionEnabled,
      extensionBundleIdentifier: `${iosBundleIdentifier}.sharing`,
      appGroupId: iosAppGroupIdentifier,
      // Uploads are written into the project for the agent to read, so any
      // file type is useful now — not just images.
      activationRule: {
        supportsText: true,
        supportsWebUrlWithMaxCount: 1,
        supportsImageWithMaxCount: 8,
        supportsMovieWithMaxCount: 8,
        supportsFileWithMaxCount: 8,
      },
    },
    android: {
      enabled: true,
      singleShareMimeTypes: ["text/plain", "*/*"],
      multipleShareMimeTypes: ["*/*"],
    },
  },
];

const notificationsPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-notifications",
  {
    icon: variant.assets.androidNotificationIcon,
    color: variant.assets.androidNotificationColor,
    mode: iosNotificationsMode,
  },
];

const manualSigningPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "./plugins/withIosManualSigning.cjs",
  {
    appleTeamId: managedIosAppleTeamId!,
    appProfileSpecifier: managedIosProvisioningProfile!,
    widgetProfileSpecifier: managedIosWidgetsProvisioningProfile!,
    identity: managedIosSigningIdentity,
    ...(managedIosSharingProvisioningProfile
      ? { sharingProfileSpecifier: managedIosSharingProvisioningProfile }
      : {}),
  },
];

const widgetLogoPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "./plugins/withWidgetLogoAsset.cjs",
  { deploymentTarget: IOS_DEPLOYMENT_TARGET },
];

// These aliases match the fonts' PostScript names on iOS. Register the same
// names on Android so React Native and the native composer use one set of
// family names without waiting for runtime font loading.

const config: ExpoConfig = {
  name: variant.appName,
  slug: "t3-code",
  platforms: ["ios", "android"],
  scheme: variant.scheme,
  version: "1.0.1",
  runtimeVersion: {
    // Fingerprint (not appVersion) so an OTA only reaches binaries whose native
    // project — native deps, config plugins, AND patches/ — matches the update.
    // With appVersion, every 0.1.0 build shares a runtime version, so a JS update
    // could land on a binary missing the native changes it needs and crash.
    policy: process.env.MOBILE_VERSION_POLICY ?? "fingerprint",
  },
  orientation: "portrait",
  icon: variant.assets.appIcon,
  userInterfaceStyle: "automatic",
  // A fork without its own EAS project must never consume updates published
  // for the upstream app. TestFlight handles binary updates independently.
  updates: expoProjectId
    ? {
        enabled: true,
        url: `https://u.expo.dev/${expoProjectId}`,
        checkAutomatically: "ON_LOAD",
        fallbackToCacheTimeout: 0,
      }
    : {
        enabled: false,
      },
  ios: {
    icon: variant.assets.iosIcon,
    supportsTablet: true,
    // Multitasking-capable iPad apps cannot rotate programmatically, so the
    // showcase capture build requires full screen (see infoPlist below).
    requireFullScreen: process.env.T3_SHOWCASE_CAPTURE_BUILD === "1",
    bundleIdentifier: iosBundleIdentifier,
    buildNumber: managedIosBuildNumber || "1",
    // Pin code signing to the T3 Tools team so non-interactive `expo run:ios`
    // does not fall back to a personal team (which cannot sign app groups,
    // Sign in with Apple, or push notification entitlements).
    appleTeamId: managedIosAppleTeamId ?? "ARK85ZXQ4Z",
    ...(isIosAssociatedDomainsEnabled
      ? {
          associatedDomains: [
            `applinks:${variant.relyingParty}`,
            `webcredentials:${variant.relyingParty}`,
          ],
        }
      : {}),
    infoPlist: {
      NSMicrophoneUsageDescription: "Allow T3 Code to record speech for Voice Input transcription.",
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
      NSLocalNetworkUsageDescription:
        "Allow T3 Code to connect to T3 Code servers on your local network or tailnet.",
      ITSAppUsesNonExemptEncryption: false,
      // The App Store screenshot harness rotates the iPad interface from
      // inside the app (CI denies osascript the Accessibility access that
      // Simulator menu scripting needs), and iPadOS ignores programmatic
      // orientation requests for multitasking-capable apps — so the capture
      // build opts out of multitasking and declares landscape support.
      ...(process.env.T3_SHOWCASE_CAPTURE_BUILD === "1"
        ? {
            "UISupportedInterfaceOrientations~ipad": [
              "UIInterfaceOrientationPortrait",
              "UIInterfaceOrientationPortraitUpsideDown",
              "UIInterfaceOrientationLandscapeLeft",
              "UIInterfaceOrientationLandscapeRight",
            ],
          }
        : {}),
    },
  },
  android: {
    icon: variant.assets.appIcon,
    package: variant.androidPackage,
    adaptiveIcon: {
      backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
      foregroundImage: variant.assets.androidAdaptiveForeground,
      monochromeImage: variant.assets.androidMonochromeIcon,
    },
    // Opts into OnBackInvokedCallback-based back dispatch (Android 13+).
    // JS back handling survives it via react-native's Android 16 shim plus
    // withAndroidPredictiveBackCompat on Android 13-15.
    predictiveBackGestureEnabled: true,
    permissions: ["android.permission.RECORD_AUDIO"],
  },
  web: {
    favicon: variant.assets.appIcon,
  },
  plugins: [
    // First in the list on purpose: same-type mods run last-registered-first,
    // so registering earliest makes this run LAST, once expo-sharing and
    // expo-widgets have created the targets it has to sign. Registered next to
    // the other iOS plugins instead, it ran before the sharing extension
    // existed and prebuild failed looking for it.
    ...(isIosManualSigningEnabled ? [manualSigningPlugin] : []),
    "expo-asset",
    [
      "expo-audio",
      {
        microphonePermission: "Allow T3 Code to record speech for Voice Input transcription.",
      },
    ],
    [
      "expo-font",
      {
        ios: {
          fonts: [dmSansFonts.regular, dmSansFonts.medium, dmSansFonts.bold],
        },
        android: {
          fonts: [
            {
              fontFamily: "DMSans-Regular",
              fontDefinitions: [{ path: dmSansFonts.regular, weight: 400 }],
            },
            {
              fontFamily: "DMSans-Medium",
              fontDefinitions: [{ path: dmSansFonts.medium, weight: 500 }],
            },
            {
              fontFamily: "DMSans-Bold",
              fontDefinitions: [{ path: dmSansFonts.bold, weight: 700 }],
            },
          ],
        },
      },
    ],
    "expo-secure-store",
    "expo-sqlite",
    ...(isIosPersonalTeamBuild || !isIosSharingExtensionEnabled
      ? [sharingPlugin]
      : ["./plugins/withShareExtensionDisplayName.cjs", sharingPlugin]),
    ...(!isIosPersonalTeamBuild ? [notificationsPlugin] : []),
    // appleSignIn must be gated here: withoutIosPersonalTeamCapabilities.cjs runs before
    // plugins earlier in this array, so it cannot strip the entitlement Clerk would add.
    ["@clerk/expo", { theme: "./clerk-theme.json", appleSignIn: !isIosPersonalTeamBuild }],
    "expo-web-browser",
    [
      "expo-quick-actions",
      {
        // Adaptive launcher-shortcut icon; referenced by resource name from
        // the shortcut items set in src/features/shortcuts.
        androidIcons: {
          shortcut_icon: {
            foregroundImage: variant.assets.androidAdaptiveForeground,
            backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
          },
        },
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission:
          "Allow T3 Code to access your camera so you can scan pairing QR codes and take photos to attach to messages.",
        microphonePermission: false,
        barcodeScannerEnabled: true,
        recordAudioAndroid: false,
      },
    ],
    ["expo-image-picker", { photosPermission: false, microphonePermission: false }],
    [
      "expo-splash-screen",
      {
        image: variant.assets.splashIcon,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        imageWidth: 220,
        dark: {
          image: variant.assets.splashIcon,
          backgroundColor: "#0a0a0a",
        },
      },
    ],
    [
      "expo-build-properties",
      {
        ios: {
          deploymentTarget: IOS_DEPLOYMENT_TARGET,
          // AppCheckCore 11.3+ includes Swift and needs module maps for these Objective-C dependencies.
          extraPods: [
            { name: "GoogleUtilities", modular_headers: true },
            { name: "RecaptchaInterop", modular_headers: true },
          ],
        },
      },
    ],
    "./plugins/withIosCocoaPodsUuidCache.cjs",
    "./plugins/withIosCcache.cjs",
    [
      "./plugins/withIosExpoConfigEnvironment.cjs",
      {
        environment: {
          APP_VARIANT,
          T3CODE_IOS_PERSONAL_TEAM: isIosPersonalTeamBuild ? "1" : "0",
          T3CODE_IOS_BUNDLE_ID: iosBundleIdentifier,
          T3CODE_IOS_APP_GROUP_ID: iosAppGroupIdentifier,
          T3CODE_IOS_APPLE_TEAM_ID: managedIosAppleTeamId ?? "ARK85ZXQ4Z",
          T3CODE_IOS_APNS_ENVIRONMENT:
            iosNotificationsMode === "development" ? "sandbox" : "production",
          T3CODE_IOS_ASSOCIATED_DOMAINS: isIosAssociatedDomainsEnabled ? "1" : "0",
          T3CODE_IOS_SHARING_EXTENSION: isIosSharingExtensionEnabled ? "1" : "0",
          // The widget and sharing extensions bake CFBundleVersion from this
          // at prebuild; without it in the sandbox snapshot they archive as
          // '1' and Xcode rejects the mismatch with the parent app's injected
          // build number.
          ...(managedIosBuildNumber ? { T3CODE_IOS_BUILD_NUMBER: managedIosBuildNumber } : {}),
        },
      },
    ],
    // Must be listed BEFORE expo-widgets: same-type mods run last-registered-
    // first, so registering earlier makes this plugin's mods run AFTER
    // expo-widgets' — its dangerous mod wipes ios/ExpoWidgetsTarget/ (which
    // would delete the asset catalog) and its xcodeproj mod creates the widget
    // target (which must exist before the compile phase can be attached).
    ...(!isIosPersonalTeamBuild ? [widgetLogoPlugin, widgetsPlugin] : []),
    "./plugins/withIosSceneLifecycle.cjs",
    "./plugins/withAndroidCleartextTraffic.cjs",
    "./plugins/withAndroidGradleHeap.cjs",
    "./plugins/withAndroidModernPopupMenu.cjs",
    "./plugins/withAndroidModernAlertDialog.cjs",
    "./plugins/withAndroidPredictiveBackCompat.cjs",
    ...(isIosPersonalTeamBuild ? ["./plugins/withoutIosPersonalTeamCapabilities.cjs"] : []),
  ],
  extra: {
    appVariant: APP_VARIANT,
    iosPersonalTeamBuild: isIosPersonalTeamBuild,
    iosSharingExtensionEnabled: isIosSharingExtensionEnabled,
    relay: {
      url: repoEnv.T3CODE_RELAY_URL ?? null,
    },
    clerk: {
      publishableKey: repoEnv.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,
      jwtTemplate: repoEnv.EXPO_PUBLIC_CLERK_JWT_TEMPLATE ?? null,
    },
    // Native Google sign-in credentials. @clerk/expo reads these from `extra`
    // under their exact env-var names (not nested), and its config plugin reads
    // the iOS URL scheme at prebuild to register it in Info.plist.
    // Unset values must be omitted (not null): the public manifest serializes
    // null to {}, which is truthy and would defeat Clerk's fallback checks.
    EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME,
    observability: {
      tracesUrl: repoEnv.EXPO_PUBLIC_OTLP_TRACES_URL ?? "https://api.axiom.co/v1/traces",
      tracesDataset: repoEnv.EXPO_PUBLIC_OTLP_TRACES_DATASET ?? null,
      tracesToken: repoEnv.EXPO_PUBLIC_OTLP_TRACES_TOKEN ?? null,
    },
    ...(expoProjectId ? { eas: { projectId: expoProjectId } } : {}),
  },
  ...(expoOwner ? { owner: expoOwner } : {}),
};

export default config;
