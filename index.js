// 根入口：OpenCode 自动发现只会加载 `plugins/<名字>/index.js`（不读 package.json#main）。
// 实现体在 ./dist/index.js（自包含 bundle，含飞书 SDK 等依赖）。
export { default } from "./dist/index.js"
