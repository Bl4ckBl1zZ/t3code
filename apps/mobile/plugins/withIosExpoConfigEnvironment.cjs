"use strict";

// Expo evaluates app.config.ts once during prebuild and again from Xcode's
// "Bundle React Native code and images" phase. Persist the public, non-secret
// iOS build inputs as user-defined target settings so the second evaluation
// cannot silently fall back to the upstream bundle IDs and capabilities.

const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const PODFILE_START_MARKER = "    # t3code: begin Expo config environment";
const PODFILE_END_MARKER = "    # t3code: end Expo config environment";

function stripComments(section) {
  return Object.fromEntries(
    Object.entries(section ?? {}).filter(([key]) => !key.endsWith("_comment")),
  );
}

function findApplicationTarget(objects) {
  return Object.entries(stripComments(objects.PBXNativeTarget)).find(([, target]) =>
    String(target?.productType ?? "").includes("com.apple.product-type.application"),
  );
}

function normalizedEnvironment(options) {
  return Object.fromEntries(
    Object.entries(options.environment ?? {}).filter(
      ([, value]) => typeof value === "string" && value.length > 0,
    ),
  );
}

function withApplicationBuildSettings(config, environment) {
  return withXcodeProject(config, (cfg) => {
    const objects = cfg.modResults.hash.project.objects;
    const targetEntry = findApplicationTarget(objects);
    if (!targetEntry) {
      throw new Error("Could not find the main iOS application target.");
    }

    const configurationList = stripComments(objects.XCConfigurationList)[
      targetEntry[1].buildConfigurationList
    ];
    if (!configurationList) {
      throw new Error("Could not find the main iOS application build configurations.");
    }

    const buildConfigurations = stripComments(objects.XCBuildConfiguration);
    for (const reference of configurationList.buildConfigurations ?? []) {
      const buildConfiguration = buildConfigurations[reference.value];
      if (buildConfiguration?.buildSettings) {
        Object.assign(buildConfiguration.buildSettings, environment);
      }
    }
    return cfg;
  });
}

function renderPodfileEnvironment(environment) {
  const entries = Object.entries(environment)
    .map(([key, value]) => `      ${JSON.stringify(key)} => ${JSON.stringify(value)},`)
    .join("\n");
  return `${PODFILE_START_MARKER}
    t3code_expo_config_environment = {
${entries}
    }
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_configuration|
        t3code_expo_config_environment.each do |key, value|
          build_configuration.build_settings[key] = value
        end
      end
    end
${PODFILE_END_MARKER}
`;
}

function withPodsBuildSettings(config, environment) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      const podfile = fs.readFileSync(podfilePath, "utf8");
      const block = renderPodfileEnvironment(environment);
      const existingBlock = new RegExp(
        `${PODFILE_START_MARKER}[\\s\\S]*?${PODFILE_END_MARKER}\\n?`,
      );
      const nextPodfile = existingBlock.test(podfile)
        ? podfile.replace(existingBlock, block)
        : podfile.replace("post_install do |installer|\n", `post_install do |installer|\n${block}`);

      if (nextPodfile === podfile && !podfile.includes(PODFILE_START_MARKER)) {
        throw new Error("Could not persist the Expo config environment: post_install is missing.");
      }
      fs.writeFileSync(podfilePath, nextPodfile, "utf8");
      return cfg;
    },
  ]);
}

module.exports = function withIosExpoConfigEnvironment(config, options = {}) {
  const environment = normalizedEnvironment(options);
  return withApplicationBuildSettings(withPodsBuildSettings(config, environment), environment);
};
