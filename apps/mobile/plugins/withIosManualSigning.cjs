"use strict";

// Applies target-specific development profiles for local archives. Xcode's
// command-line overrides are global, so without this split the widget target
// incorrectly receives the main app's profile (or vice versa).

const { withXcodeProject } = require("expo/config-plugins");

function stripComments(section) {
  return Object.fromEntries(
    Object.entries(section ?? {}).filter(([key]) => !key.endsWith("_comment")),
  );
}

function findByName(section, name) {
  return Object.entries(stripComments(section)).find(([, value]) => value?.name === name) ?? null;
}

function applySigningSettings(objects, targetEntry, { appleTeamId, profileSpecifier }) {
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
      buildConfiguration.buildSettings.CODE_SIGN_IDENTITY = '"Apple Development"';
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
    const { appleTeamId, appProfileSpecifier, widgetProfileSpecifier } = options;
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
      profileSpecifier: appProfileSpecifier,
    });
    applySigningSettings(objects, widgetTarget, {
      appleTeamId,
      profileSpecifier: widgetProfileSpecifier,
    });
    return cfg;
  });
};
