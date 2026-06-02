import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // ACP client tests spawn child Bun peers; serial files avoid CI load-sensitive timeouts.
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);
