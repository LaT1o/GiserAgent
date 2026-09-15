/**
 * GiserAgent 桌面端 server 子进程控制（纯 Node 实现，不依赖 Electron）。
 *
 * main.cjs 在应用启动时引入并调用；electron/smoke.cjs（无 GUI 冒烟）复用同一实现，
 * 保证「spawn server → 身份健康检查 → 清理」链路可以不开窗口独立验证。
 *
 * 关键语义：
 * - /api/health 必须返回 { status: "ok", app: "GiserAgent" }（额外字段兼容），
 *   只有身份匹配的服务才允许复用；端口被其他程序占用时跳过，绝不结束外部进程。
 * - 所有 HTTP 探测带单次超时（AbortSignal.timeout），等待进程退出即时失败，
 *   不会出现「hang 住的请求/已死进程」导致长时间静默等待。
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

/** /api/health 中的应用身份字段值；不匹配的一律视为外部服务，不复用、不结束 */
const HEALTH_APP_ID = "GiserAgent";
/** 日志文件大小上限（超过后清空重写，避免无限增长） */
const LOG_MAX_BYTES = 2 * 1024 * 1024;
/** 保留在内存中的子进程输出末段长度（用于失败提示） */
const TAIL_LIMIT = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 探测端口是否有进程监听（TCP 可连即视为占用，无论对方是谁） */
function probePortOpen(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
    socket.setTimeout(timeoutMs);
  });
}

/**
 * 单次健康检查（带超时）。
 * 返回 { reachable, identity, mode }：
 * - reachable：该端口有 HTTP 响应；
 * - identity：响应体为 { status: "ok", app: "GiserAgent" }（额外字段兼容）；
 * - mode：服务的运行形态（"source"=tsx 源码纯 API / "bundle"=构建产物托管前端），
 *   旧版本服务无该字段时按 "bundle" 对待（保持向后兼容）。
 */
async function fetchHealth(port, timeoutMs) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { reachable: true, identity: false, mode: null };
    const body = await res.json().catch(() => null);
    const identity = !!body && body.status === "ok" && body.app === HEALTH_APP_ID;
    const mode = identity ? (body.mode === "source" ? "source" : "bundle") : null;
    return { reachable: true, identity, mode };
  } catch {
    return { reachable: false, identity: false, mode: null };
  }
}

/** 扫描端口段，返回第一个通过身份校验的已有实例 { port, mode }；没有则返回 null */
async function findExistingServer({ basePort, count, healthTimeoutMs }) {
  for (let port = basePort; port < basePort + count; port++) {
    if (!(await probePortOpen(port))) continue;
    const { identity, mode } = await fetchHealth(port, healthTimeoutMs);
    if (identity) return { port, mode };
  }
  return null;
}

/** 追加一行日志（自动加时间戳；命中密钥样式的片段脱敏为 ***；超限清空重写；只记输出不记 env） */
function redact(message) {
  return String(message)
    .replace(/(authorization\s*[=:]\s*(?:bearer|basic)\s+)[^\s,，;；"']+/gi, "$1***")
    .replace(/(api[_-]?key|token|secret|password|authorization)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,，;；"']+)/gi, "$1$2***");
}

function appendLog(logFile, message) {
  try {
    const sanitized = redact(message);
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_MAX_BYTES) {
      fs.rmSync(logFile, { force: true });
    }
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${sanitized}\n`);
  } catch {
    /* 日志写入失败不影响主流程 */
  }
}

/**
 * 启动 server 子进程，stdout/stderr 落盘到 logFile 并保留末段。
 * - 生产：ELECTRON_RUN_AS_NODE 让 electron 二进制以纯 Node 运行 build/server.mjs
 *   （headless 子进程，绝不打开 GUI）；GISER_PROJECT_DIR 指回真实项目根
 *   （打包产物里 import.meta.url 推导不可靠）。
 * - 开发：npx tsx 直跑源码（供 smoke 冒烟使用；主进程 dev 模式不 spawn）。
 * - cwd：工作目录，默认 server 目录；冒烟可传隔离的测试根（bundle 的依赖解析
 *   走 build/server.mjs 自身路径向上，不依赖 cwd）。
 * 返回 { proc, tail, state }：tail.text 为输出末段，state.spawnError 为 spawn 阶段错误。
 */
function spawnServer({ rootDir, isDev, port, logFile, cwd, executable = process.execPath }) {
  const serverDir = path.join(rootDir, "server");
  const env = { ...process.env, PORT: String(port) };
  let proc;
  if (isDev) {
    proc = spawn("npx", ["tsx", "src/index.ts"], {
      cwd: cwd || serverDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
  } else {
    const bundle = path.join(serverDir, "build", "server.mjs");
    if (!fs.existsSync(bundle)) {
      throw new Error(`未找到 server 构建产物: ${bundle}\n请先在 frontend/ 运行 npm run build:server`);
    }
    env.ELECTRON_RUN_AS_NODE = "1";
    env.GISER_PROJECT_DIR = rootDir;
    proc = spawn(executable, [bundle], {
      cwd: cwd || serverDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  const tail = { text: "" };
  const state = { spawnError: null };
  proc.once("error", (err) => {
    state.spawnError = err;
  });
  const forward = (chunk, streamName) => {
    const text = redact(chunk.toString());
    tail.text = (tail.text + text).slice(-TAIL_LIMIT);
    appendLog(logFile, `[server:${streamName}] ${text.trimEnd()}`);
  };
  proc.stdout?.on("data", (chunk) => forward(chunk, "out"));
  proc.stderr?.on("data", (chunk) => forward(chunk, "err"));
  return { proc, tail, state };
}

/**
 * 等待我们 spawn 的 server 通过身份健康检查。
 * - 进程提前退出 / spawn 出错 → 立即失败（不空等超时）；err.earlyExit=true，
 *   err.portTaken 按输出中是否出现 EADDRINUSE 判定（用于换端口重试）；
 * - 超过 timeoutMs 仍未就绪 → 失败（err.earlyExit=false）。
 * 注意：退出码可能先于 stdio 数据事件到达，检测到退出后短暂宽限再取输出末段。
 */
async function waitServerReady({ proc, port, timeoutMs, pollMs, healthTimeoutMs, tail, state }) {
  const deadline = Date.now() + timeoutMs;
  const tailText = () => (tail && tail.text || "").trim() || "(无输出)";
  while (Date.now() < deadline) {
    if (state && state.spawnError) {
      const err = new Error(`server 子进程启动失败: ${state.spawnError.message}`);
      err.earlyExit = true;
      err.portTaken = false;
      throw err;
    }
    if (proc.exitCode !== null || proc.signalCode !== null) {
      await sleep(300); // 宽限 stdio 刷盘，保证错误信息带得上输出末段
      const text = tailText();
      const err = new Error(
        `GiserAgent 服务进程启动后立即退出（code=${proc.exitCode}）。\n输出末段:\n${text}`
      );
      err.earlyExit = true;
      err.portTaken = /EADDRINUSE|端口.*已被占用/i.test((tail && tail.text) || "");
      throw err;
    }
    const { identity } = await fetchHealth(port, healthTimeoutMs);
    if (identity) return { port };
    await sleep(pollMs);
  }
  const err = new Error(
    `等待 GiserAgent 服务就绪超时（${Math.round(timeoutMs / 1000)} 秒，端口 ${port}）。\n输出末段:\n${tailText()}`
  );
  err.earlyExit = false;
  throw err;
}

/** 结束子进程树（server 可能再 spawn python 等子进程；Windows 用 taskkill /T /F） */
function killProcessTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    /* 已退出 */
  }
}

module.exports = {
  HEALTH_APP_ID,
  probePortOpen,
  fetchHealth,
  findExistingServer,
  appendLog,
  spawnServer,
  waitServerReady,
  killProcessTree,
};
