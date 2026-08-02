"use strict";

// Routes Pods compilation through ccache wrapper scripts at a fixed absolute
// path outside the repo. expo-build-properties' ccacheEnabled points at
// react-native's ccache-clang.sh via $(REACT_NATIVE_PATH), which does not
// resolve inside the EAS local build sandbox with the pnpm layout. The CI
// workflow creates the wrappers before building; when they are absent (dev
// machines, OTA publish runners) the plugin is inert. Gating on the filesystem
// instead of env keeps the evaluated Expo config — and therefore the updates
// fingerprint — identical whether or not ccache is in play.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

const PODFILE_START_MARKER = "    # t3code: begin ccache compilers";
const PODFILE_END_MARKER = "    # t3code: end ccache compilers";

function wrapperDirectory() {
  return path.join(os.homedir(), ".t3code-ccache", "bin");
}

function renderPodfileBlock(clangWrapper, clangxxWrapper) {
  const settings = {
    CC: clangWrapper,
    LD: clangWrapper,
    CXX: clangxxWrapper,
    LDPLUSPLUS: clangxxWrapper,
  };
  const entries = Object.entries(settings)
    .map(([key, value]) => `      ${JSON.stringify(key)} => ${JSON.stringify(value)},`)
    .join("\n");
  return `${PODFILE_START_MARKER}
    t3code_ccache_compilers = {
${entries}
    }
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_configuration|
        t3code_ccache_compilers.each do |key, value|
          build_configuration.build_settings[key] = value
        end
      end
    end
${PODFILE_END_MARKER}
`;
}

module.exports = function withIosCcache(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const clangWrapper = path.join(wrapperDirectory(), "ccache-clang.sh");
      const clangxxWrapper = path.join(wrapperDirectory(), "ccache-clang++.sh");
      if (!fs.existsSync(clangWrapper) || !fs.existsSync(clangxxWrapper)) {
        return cfg;
      }

      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      const podfile = fs.readFileSync(podfilePath, "utf8");
      const block = renderPodfileBlock(clangWrapper, clangxxWrapper);
      const existingBlock = new RegExp(
        `${PODFILE_START_MARKER}[\\s\\S]*?${PODFILE_END_MARKER}\\n?`,
      );
      const nextPodfile = existingBlock.test(podfile)
        ? podfile.replace(existingBlock, block)
        : podfile.replace("post_install do |installer|\n", `post_install do |installer|\n${block}`);

      if (nextPodfile === podfile && !podfile.includes(PODFILE_START_MARKER)) {
        throw new Error("Could not enable ccache: post_install is missing from the Podfile.");
      }
      fs.writeFileSync(podfilePath, nextPodfile, "utf8");
      return cfg;
    },
  ]);
};
