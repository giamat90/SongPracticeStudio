import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    // The package ships TypeScript source, which Node will not load from node_modules.
    server: { deps: { inline: [/@giamat90\/mps-core/] } },
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
