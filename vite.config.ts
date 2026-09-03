import { defineConfig } from "vitest/config";

// Relative base so the same build serves from GitHub Pages under a
// sub-path and from the local bridge at the root.
export default defineConfig({
  base: "./",
  build: { outDir: "dist", sourcemap: true, target: "es2022" },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
