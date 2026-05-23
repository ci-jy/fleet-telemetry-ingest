import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The fault-injection suite needs Docker; it runs with `npm run test:chaos`.
    exclude: ["test/chaos/**", "**/node_modules/**"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
