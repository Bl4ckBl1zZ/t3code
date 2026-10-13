"use strict";

// Applies target-specific provisioning profiles for archives. Xcode's
// command-line overrides are global, so without this split the widget target
// incorrectly receives the main app's profile (or vice versa).
//
// Used for both local development archives ("Apple Development") and App Store
// releases ("Apple Distribution"), which is why the identity is a parameter: an
// App Store archive signed with a development identity is rejected at export,
// and the failure surfaces as an opaque profile-mismatch error.

const { withXcodeProject } = require("expo/config-plugins");

/** Quoted: the pbxproj writer emits keys verbatim, and bare brackets do not parse. */
const SDK_CODE_SIGN_IDENTITY_KEY = '"CODE_SIGN_IDENTITY[sdk=iphoneos*]"';

function stripComments(section) {
  return Object.fromEntries(
    Object.entries(section ?? {}).filter(([key]) => !key.endsWith("_comment")),
  );
}

function findByName(section, name) {
  return Object.entries(stripComments(section)).find(([, value]) => value?.name === name) ?? null;
}

function applySigningSettings(objects, targetEntry, { appleTeamId, profileSpecifier, identity }) {
  const [targetId, target] = targetEntry;
  const configurationList = stripComments(objects.XCConfigurationList)[
    target.buildConfigurationList
  ];
  if (!configurationList) {
    throw new Error(`Could not find build configurations for ${target.name}.`);
  }

  const buildConfigurations = stripComments(objects.XCBuildConfiguration);
  for (const reference of configurationList.buildConfigurations ?? []) {
    const buildConfiguration = buildConfigurations[reference.value];
    if (buildConfiguration?.buildSettings) {
      buildConfiguration.buildSettings.CODE_SIGN_STYLE = "Manual";
      buildConfiguration.buildSettings.CODE_SIGN_IDENTITY = JSON.stringify(identity);
      // The SDK-suffixed variant wins over the plain one when both are present,
      // so a value inherited from the template would silently override the line
      // above. The key is quoted because the pbxproj writer emits keys verbatim
      // and bare brackets are a syntax error.
      if (SDK_CODE_SIGN_IDENTITY_KEY in buildConfiguration.buildSettings) {
        buildConfiguration.buildSettings[SDK_CODE_SIGN_IDENTITY_KEY] = JSON.stringify(identity);
      }
      buildConfiguration.buildSettings.DEVELOPMENT_TEAM = appleTeamId;
      buildConfiguration.buildSettings.PROVISIONING_PROFILE_SPECIFIER =
        JSON.stringify(profileSpecifier);
    }
  }

  const project = Object.values(stripComments(objects.PBXProject))[0];
  const attributes = project?.attributes?.TargetAttributes?.[targetId];
  if (attributes) {
    attributes.DevelopmentTeam = appleTeamId;
    attributes.ProvisioningStyle = "Manual";
  }
}

module.exports = function withIosManualSigning(config, options = {}) {
  return withXcodeProject(config, (cfg) => {
    const {
      appleTeamId,
      appProfileSpecifier,
      widgetProfileSpecifier,
      sharingProfileSpecifier,
      identity = "Apple Development",
    } = options;
    if (!appleTeamId || !appProfileSpecifier || !widgetProfileSpecifier) {
      throw new Error(
        "Manual iOS signing requires appleTeamId, appProfileSpecifier, and widgetProfileSpecifier.",
      );
    }

    const objects = cfg.modResults.hash.project.objects;
    const appTarget = Object.entries(stripComments(objects.PBXNativeTarget)).find(([, target]) =>
      String(target?.productType ?? "").includes("com.apple.product-type.application"),
    );
    const widgetTarget = findByName(objects.PBXNativeTarget, "ExpoWidgetsTarget");
    if (!appTarget || !widgetTarget) {
      throw new Error("Could not find the main app and ExpoWidgetsTarget signing targets.");
    }

    applySigningSettings(objects, appTarget, {
      appleTeamId,
      identity,
      profileSpecifier: appProfileSpecifier,
    });
    applySigningSettings(objects, widgetTarget, {
      appleTeamId,
      identity,
      profileSpecifier: widgetProfileSpecifier,
    });

    // The sharing extension is optional (T3CODE_IOS_SHARING_EXTENSION=0 drops
    // it), so a missing target is a valid configuration rather than an error —
    // but a profile supplied for a target that is not there is a mistake worth
    // reporting, since the archive would otherwise fail much later at export.
    const sharingTarget = findByName(objects.PBXNativeTarget, "expo-sharing-extension");
    if (sharingProfileSpecifier) {
      if (!sharingTarget) {
        throw new Error(
          "A sharing extension profile was supplied but the expo-sharing-extension target is missing.",
        );
      }
      applySigningSettings(objects, sharingTarget, {
        appleTeamId,
        identity,
        profileSpecifier: sharingProfileSpecifier,
      });
    }
    return cfg;
  });
};
