import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  sourcemap: true,
  dts: true,
  clean: true,
  outDir: "dist",
  splitting: false,
  treeshake: true,
  minify: false,
  // @opencode/plugin is provided by the host opencode process.
  external: ["@opencode/plugin", "ws"],
  // Bundle the Feishu SDK so the published plugin is self-contained.
  noExternal: ["@larksuiteoapi/node-sdk"],
});
