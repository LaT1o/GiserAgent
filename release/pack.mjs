#!/usr/bin/env node
/**
 * GiserAgent 打包脚本（唯一打包入口）。
 *
 * 用法：
 *   根目录执行      node release/pack.mjs
 *   或 frontend 下  npm run pack
 *
 * 行为：
 *   1. 读取 frontend/package.json 的 version，产物输出到 release/<version>/
 *      （安装包、blockmap、builder-debug.yml 与 win-unpacked/ 均在该目录）；
 *   2. 依次执行前端构建（tsc + vite）、后端 bundle（esbuild）、electron-builder（--win nsis）；
 *   3. 默认注入 npmmirror 镜像环境变量，避免 electron 与 electron-builder 辅助件
 *      从 GitHub 下载卡死（可在外部设置同名变量覆盖）。
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url)); // <仓库根>/release
const root = join(scriptDir, "..");
const frontendDir = join(root, "frontend");

const version = JSON.parse(readFileSync(join(frontendDir, "package.json"), "utf8")).version;
const outputDir = join(root, "release", version);

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? "https://npmmirror.com/mirrors/electron/",
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? "https://npmmirror.com/mirrors/electron-builder-binaries/",
};

/** 同步执行子步骤，失败立即中止并透传退出码 */
const run = (label, command, args, cwd) => {
  console.log(`\n==> ${label}: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env, shell: process.platform === "win32" });
  if (result.status !== 0) {
    console.error(`\n[pack] 步骤失败（exit ${result.status}）：${label}`);
    process.exit(result.status ?? 1);
  }
};

console.log(`[pack] GiserAgent v${version} → ${outputDir}`);
run("前端构建", "npm", ["run", "build"], frontendDir);
run("后端 bundle", "npm", ["run", "build:server"], frontendDir);
// -c 覆盖 package.json build 配置里的 directories.output，指向版本目录（绝对路径最稳）
run("electron-builder", "npx", ["electron-builder", "--win", "nsis", `-c.directories.output=${outputDir}`], frontendDir);

console.log(`\n[pack] 完成：${outputDir}`);
