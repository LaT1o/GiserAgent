/**
 * electron-builder afterPack 钩子（package.json → build.afterPack）。
 *
 * 背景：server 以 esbuild --packages=external 打包为 build/server.mjs，运行时必须
 * 依赖 server/node_modules 原样存在；而 electron-builder 的 files / extraResources
 * 过滤默认忽略 node_modules（上一版产物 resources/server/node_modules 因此整包丢失）。
 * 本钩子在 app 目录（win-unpacked）组装完成后，用 node:fs cpSync 把完整的
 * server/node_modules（含嵌套依赖与 .bin）复制进 resources/server/node_modules，
 * 不依赖 builder 的过滤规则，并对运行时关键依赖做可解析断言——任何断言失败都会
 * 让打包立即失败，而不是等用户运行时才报“Cannot find package”。
 *
 * 若输出目录中发现密钥或用户工作区则中止打包，防止将数据带入安装包或覆盖旧输出中的用户数据。
 */

const { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } = require("node:fs");
const path = require("node:path");

/** server 运行必需的直接依赖（兜底清单；打包后会连同 package.json 声明的全部依赖一起断言） */
const CRITICAL_DEPS = [
  "fastify",
  "@fastify/static",
  "dotenv",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
];

/** 复制后必须不存在的敏感文件/目录（相对 resources/server/ 的路径） */
const SENSITIVE_PATHS = [".env", ".pi/auth.json", "workspace"];

/**
 * 按 Node 的解析算法检查 dep 能否从 fromDir 解析：逐级向上为每个祖先目录拼
 * node_modules/<dep> 检查存在性（覆盖嵌套安装布局；只看目录存在性，不加载模块，
 * 不受 package.json exports 子路径限制）。
 */
function resolveDepDir(fromDir, dep) {
  let cur = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(cur, "node_modules", dep);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** 递归统计目录字节数（仅用于打包日志输出体量） */
function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(p);
    else total += statSync(p).size;
  }
  return total;
}

/**
 * 断言打包产物中 server 运行时依赖完整：
 * 1) node_modules 存在且非空；
 * 2) server/package.json 声明的全部 dependencies + CRITICAL_DEPS 兜底清单均可解析；
 * 3) fastify 的全部直接依赖可解析（嵌套依赖复制完整性的代表抽样）。
 */
function assertRuntimeModules(packagedServerDir) {
  const nm = path.join(packagedServerDir, "node_modules");
  if (!existsSync(nm) || readdirSync(nm).filter((n) => n !== ".bin" && n !== ".package-lock.json").length === 0) {
    throw new Error(`[afterPack] 打包产物缺少 server/node_modules: ${nm}`);
  }

  const required = new Set(CRITICAL_DEPS);
  try {
    const pkg = JSON.parse(readFileSync(path.join(packagedServerDir, "package.json"), "utf8"));
    for (const dep of Object.keys(pkg.dependencies || {})) required.add(dep);
  } catch {
    throw new Error(`[afterPack] 无法读取打包产物中的 server/package.json: ${packagedServerDir}`);
  }
  for (const dep of required) {
    const resolved = resolveDepDir(packagedServerDir, dep);
    if (!resolved || !resolved.startsWith(nm + path.sep) || !existsSync(path.join(resolved, "package.json"))) {
      throw new Error(`[afterPack] 打包产物中无法解析运行时依赖: ${dep}（自 ${packagedServerDir} 向上查找 node_modules 失败）`);
    }
  }

  const fastifyDir = resolveDepDir(packagedServerDir, "fastify");
  const fastifyPkg = JSON.parse(readFileSync(path.join(fastifyDir, "package.json"), "utf8"));
  for (const dep of Object.keys(fastifyPkg.dependencies || {})) {
    const resolved = resolveDepDir(fastifyDir, dep);
    if (!resolved || !resolved.startsWith(nm + path.sep) || !existsSync(path.join(resolved, "package.json"))) {
      throw new Error(`[afterPack] fastify 的依赖不可解析: ${dep}（node_modules 复制不完整）`);
    }
  }
}

/**
 * 断言安装包内的 models.json 是空模板：安装包不携带开发机的 provider/网关配置，
 * 首次启动应由用户自己在界面添加提供商。该文件由 extraResources 从
 * server/.pi/models.default.json 映射生成。
 */
function assertPackagedModelsEmpty(packagedServerDir) {
  const file = path.join(packagedServerDir, ".pi", "models.json");
  if (!existsSync(file)) {
    throw new Error(
      `[afterPack] 打包产物缺少 resources/server/.pi/models.json（应由 extraResources 从 models.default.json 生成）: ${file}`
    );
  }
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`[afterPack] 打包产物中的 .pi/models.json 无法解析: ${file}`);
  }
  const providers = data?.providers;
  if (!providers || typeof providers !== "object" || Object.keys(providers).length > 0) {
    throw new Error(
      "[afterPack] 打包产物中的 .pi/models.json 含预置提供商，已停止打包（安装包应零提供商，由用户自行配置）"
    );
  }
}

/** electron-builder afterPack 入口 */
async function afterPack(context) {
  const appOutDir = context.appOutDir; // 如 frontend/release/win-unpacked
  const resourcesDir = path.join(appOutDir, "resources");
  const packagedServerDir = path.join(resourcesDir, "server");
  // 源 server 目录：本文件位于 frontend/electron/，向上两级即项目根
  const sourceServerDir = path.resolve(__dirname, "..", "..", "server");

  if (!existsSync(packagedServerDir)) {
    throw new Error(`[afterPack] extraResources 未产出 resources/server，请检查 package.json 的 extraResources 配置: ${packagedServerDir}`);
  }
  if (!existsSync(path.join(packagedServerDir, "build", "server.mjs"))) {
    throw new Error("[afterPack] 缺少 server 构建产物 build/server.mjs，请先在 frontend/ 运行 npm run build:server");
  }

  for (const target of [path.join(resourcesDir, "workspace"), ...SENSITIVE_PATHS.map((rel) => path.join(packagedServerDir, rel))]) {
    if (existsSync(target)) throw new Error(`[afterPack] 输出目录中存在本地数据或密钥，已停止打包，请使用新的输出目录：${target}`);
  }
  assertPackagedModelsEmpty(packagedServerDir);

  // 2) 完整复制 server/node_modules（含嵌套依赖与 .bin），不依赖 builder 过滤
  const srcNm = path.join(sourceServerDir, "node_modules");
  const destNm = path.join(packagedServerDir, "node_modules");
  if (!existsSync(srcNm)) {
    throw new Error(`[afterPack] 源 server/node_modules 不存在，请先在 server/ 运行 npm install: ${srcNm}`);
  }
  rmSync(destNm, { recursive: true, force: true });
  cpSync(srcNm, destNm, { recursive: true });
  const sizeMb = (dirSizeBytes(destNm) / 1024 / 1024).toFixed(1);
  console.log(`[afterPack] 已复制 server/node_modules → resources/server/node_modules（${sizeMb} MB）`);

  // 3) 运行时依赖断言：任一失败即终止打包
  assertRuntimeModules(packagedServerDir);
  console.log("[afterPack] server 运行时依赖断言通过（package.json 全部依赖 + fastify 嵌套依赖均可解析）");
}

module.exports = afterPack;
module.exports.afterPack = afterPack;
module.exports.assertRuntimeModules = assertRuntimeModules;
module.exports.assertPackagedModelsEmpty = assertPackagedModelsEmpty;
module.exports.resolveDepDir = resolveDepDir;
