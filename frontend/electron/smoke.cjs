/**
 * 无 GUI 桌面启动冒烟：不开任何 Electron 窗口，直接验证
 * 「spawn server 产物 → /api/health 身份校验 → 清理子进程」全链路。
 * 复用与主进程完全相同的实现（electron/server-process.cjs）；生产模式下
 * spawnServer 以 ELECTRON_RUN_AS_NODE 运行 build/server.mjs，全程无 GUI。
 *
 * 测试隔离约定：
 * - 每次运行用 fs.mkdtemp 建独立临时根（日志、冒烟工作区都在其中），不用固定共享目录；
 * - 子进程 cwd 指向冒烟临时根，依赖解析不受影响（走 bundle 自身路径向上）；
 * - 剔除当前环境中的敏感变量（*API_KEY / *TOKEN / *SECRET / *PASSWORD / *AUTHORIZATION），
 *   并用 DOTENV_CONFIG_PATH 指向临时根的空文件，阻断 dotenv/config 读取源码 server/.env；
 * - 工作区经 GISER_WORKSPACE_DIR 指向临时根（需 server/src/config.ts 支持），不写用户 workspace/。
 *
 * 用法（在 frontend/ 下）:
 *   npm run smoke:desktop
 *   node electron/smoke.cjs --port 3210 --timeout 60000
 *
 * 依赖 server/build/server.mjs（先在 frontend/ 运行 npm run build:server）。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const serverProcess = require("./server-process.cjs");

/** 视为敏感、不传给被测子进程的环境变量名模式 */
const SECRET_ENV_RE = /(API_?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)/i;
// 默认检查源码构建；传 --root 指向打包 resources、--executable 指向包内 exe 可检查实际安装包。
const DEFAULT_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_PORT = 3210;
const DEFAULT_TIMEOUT_MS = 60_000;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function waitProcExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function main() {
  const rootDir = path.resolve(argValue("--root") || DEFAULT_ROOT);
  const port = Number(argValue("--port") || DEFAULT_PORT);
  const timeoutMs = Number(argValue("--timeout") || DEFAULT_TIMEOUT_MS);
  const executable = argValue("--executable") || process.execPath;

  // 独立临时根：日志与冒烟工作区都在其中，互不串扰、不写用户数据
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "giseragent-smoke-"));
  const logFile = path.join(smokeRoot, "smoke.log");
  fs.writeFileSync(path.join(smokeRoot, "no-env"), ""); // dotenv 空配置：阻断读取源码 server/.env

  // 剔除敏感环境变量 + 重定向 dotenv + 隔离工作区（spawnServer 会整体继承 process.env）
  for (const key of Object.keys(process.env)) {
    if (SECRET_ENV_RE.test(key)) delete process.env[key];
  }
  process.env.DOTENV_CONFIG_PATH = path.join(smokeRoot, "no-env");
  process.env.GISER_WORKSPACE_DIR = path.join(smokeRoot, "workspace");

  console.log(`[smoke] 项目根: ${rootDir}`);
  console.log(`[smoke] 端口: ${port}，超时: ${timeoutMs}ms`);
  console.log(`[smoke] 冒烟临时根: ${smokeRoot}`);
  console.log(`[smoke] GISER_WORKSPACE_DIR: ${process.env.GISER_WORKSPACE_DIR}`);

  if (await serverProcess.probePortOpen(port)) {
    console.error(`[smoke] 失败: 端口 ${port} 已被占用，请用 --port 换一个空闲端口（不会替你结束已有进程）`);
    process.exitCode = 2;
    return;
  }

  let started;
  try {
    started = serverProcess.spawnServer({ rootDir, isDev: false, port, logFile, cwd: smokeRoot, executable });
  } catch (err) {
    console.error(`[smoke] 失败: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  try {
    await serverProcess.waitServerReady({
      proc: started.proc,
      port,
      timeoutMs,
      pollMs: 500,
      healthTimeoutMs: 3000,
      tail: started.tail,
      state: started.state,
    });
    const { reachable, identity } = await serverProcess.fetchHealth(port, 3000);
    console.log(`[smoke] 通过: 127.0.0.1:${port} reachable=${reachable} identity=${identity}（status=ok & app=GiserAgent）`);
    console.log("[smoke] spawn → 健康身份校验 → 清理 全链路 OK");
  } catch (err) {
    console.error(`[smoke] 失败: ${err.message}`);
    console.error(`[smoke] 完整日志: ${logFile}`);
    process.exitCode = 1;
  } finally {
    serverProcess.killProcessTree(started.proc);
    const exited = await waitProcExit(started.proc, 10_000);
    const listening = await serverProcess.probePortOpen(port);
    console.log(`[smoke] 子进程已结束: ${exited ? "是" : "否"}；测试端口已释放: ${listening ? "否" : "是"}`);
    if (!exited || listening) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[smoke] 异常:", err);
  process.exitCode = 1;
});
