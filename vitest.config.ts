import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/audio/**", "src/stores/**"],
      exclude: ["src/**/*.test.ts", "src/test/**", "src/lib/__fixtures__/**"],
      reporter: ["text-summary", "text"],
    },
  },
});
