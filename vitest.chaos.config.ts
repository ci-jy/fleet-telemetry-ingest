import { defineConfig } from "vitest/config";

// Fault-injection suite: one file per scenario, run one at a time against the shared
// Compose environment started by the global setup.
export default defineConfig({
  test: {
    include: ["test/chaos/**/*.chaos.test.ts"],
    globalSetup: ["test/chaos/globalSetup.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 600_000,
    hookTimeout: 900_000,
  },
});
