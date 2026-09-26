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
  // 全部打包：opencode 的 Bun 加载器不跟随 node_modules 符号链接，
  // 外部依赖会导致 "Cannot find package"。自包含最稳。
  noExternal: [/.*/],
  external: [],
});
