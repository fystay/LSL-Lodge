import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
  // `server-only` throws outside a React Server Components bundle; in tests it
  // is a no-op.
  "server-only": fileURLToPath(
    new URL("./tests/support/server-only-stub.ts", import.meta.url),
  ),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["src/**/*.integration.test.ts"],
          globalSetup: ["tests/support/integration-setup.ts"],
          // Tests share one database; run files serially.
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
