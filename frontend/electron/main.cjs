/**
 * GiserAgent 桌面窗口（Electron 主进程，位于 frontend/electron/）。
 *
 * 启动流程：单实例锁 → 启动画面 → server 子进程（spawn/复用，含身份校验）→
 * 健康检查通过 → 主窗口加载前端 → 关闭启动画面。任一环节失败都会：
 * 结束本次自己启动的进程 → 弹出中文错误对话框（含原因与日志位置，可打开日志目录）→ 退出。
 *
 * - 生产模式：spawn server/build/server.mjs（纯 Node 模式），加载 http://127.0.0.1:<port>
 *   （server 以 @fastify/static 托管 frontend/dist）。端口段内已有「身份匹配」的
 *   GiserAgent 实例则直接复用；被其他程序占用的端口跳过，绝不结束外部进程。
 * - 开发模式（--dev）：前端与后端完全分离——前端由本进程 spawn vite（HMR，
 *   Electron 与浏览器加载同一地址，改前端代码即时热更；5173 已有外部 vite 则复用）；
 *   后端由外部启动（server/ npm run dev），本进程只做身份校验与带超时等待。
 *
 * server 子进程控制逻辑在 electron/server-process.cjs（纯 Node，可无 GUI 冒烟）。
 * 常驻语义：窗口关闭仅隐藏到系统托盘；托盘右键「退出」才结束本次拥有的进程并退出。
 */

const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const serverProcess = require("./server-process.cjs");

// ==================== 运行配置（可直接编辑的默认值；同名环境变量优先） ====================

/** 起始端口（与 server 默认一致；被占用时向后排描，仅复用身份匹配的 bundle 服务） */
const BASE_PORT = Number(process.env.GISER_PORT || 13001);
/** 端口扫描数量：从 BASE_PORT 起连续尝试的端口个数 */
const PORT_SCAN_COUNT = 20;
/** 前端开发服务器地址（--dev 模式加载） */
const DEV_URL = process.env.GISER_DEV_URL || "http://localhost:5173";
/** 生产模式 spawn server 后等待健康检查（含身份校验）通过的总时限（毫秒） */
const SERVER_START_TIMEOUT_MS = Number(process.env.GISER_SERVER_START_TIMEOUT_MS || 90_000);
/** 单次健康检查/探测请求的超时毫秒数（防止单个请求 hang 住卡死整个启动） */
const HEALTH_TIMEOUT_MS = 3_000;
/** 健康检查轮询间隔（毫秒） */
const HEALTH_POLL_MS = 500;
/** 开发模式等待外部 server / Vite 就绪的总时限（毫秒），超时弹窗退出 */
const DEV_WAIT_TIMEOUT_MS = Number(process.env.GISER_DEV_WAIT_TIMEOUT_MS || 60_000);
/** 生产模式下因端口竞态（EADDRINUSE）等原因最多换端口重试的 spawn 次数 */
const MAX_SPAWN_ATTEMPTS = 3;
/** 主窗口默认/最小尺寸（前端为响应式布局，最小 720x500）与背景色（中性黑） */
const WINDOW_OPTS = {
  width: 1440,
  height: 900,
  minWidth: 720,
  minHeight: 500,
  backgroundColor: "#121212",
};

// 开发态：frontend/electron → 项目根；打包态：extraResources 都挂在 resources/ 下
const ROOT = app.isPackaged
  ? process.resourcesPath || path.resolve(__dirname, "..", "..")
  : path.resolve(__dirname, "..", "..");
const IS_DEV = process.argv.includes("--dev");

let serverProc = null; // 本次启动 spawn 的 server 子进程（可能为 null：复用外部实例时）
let serverOwned = false; // 是否拥有 server 子进程；退出时只清理自己启动的
let win = null;
let tray = null;
let splash = null;
let logFile = ""; // userData/logs/startup.log，启动事件与 server 输出都写在这里
let failureHandled = false; // 首个失败即弹窗退出，避免 loadURL/did-fail-load 双路径重复处理

/** 追加一行启动日志（server-process 内部做了脱敏与轮转） */
function logLine(message) {
  if (logFile) serverProcess.appendLog(logFile, message);
}

/** 探测端口是否可连（server 是否已在该端口监听） */
function portOpen(port) {
  return serverProcess.probePortOpen(port, 800);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== 启动画面 ====================

/** 启动画面：等待 server 就绪期间展示 logo（主窗 did-finish-load 后关闭；失败时销毁）。
 *  样式/脚本均为同目录外部文件（splash.css / splash.js），CSP 为 default-src 'self'。 */
function createSplash() {
  const splashWin = new BrowserWindow({
    width: 380,
    height: 380,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    center: true,
    show: false,
  });
  // logo 由 splash.html 以相对路径 build/logo.png 加载（files 已纳入 electron/build/logo.png）
  // 失败重试一次：新解压目录首启时可能被杀软实时扫描短暂锁文件（ERR_FAILED -2）
  const loadSplash = (attempt) =>
    splashWin.loadFile(path.join(__dirname, "splash.html")).catch((error) => {
      if (attempt === 0) return loadSplash(1);
      void failStartup(error);
    });
  loadSplash(0);
  splashWin.once("ready-to-show", () => { if (!splashWin.isDestroyed()) splashWin.show(); });
  return splashWin;
}

function closeSplash() {
  if (splash && !splash.isDestroyed()) splash.close();
}

function destroySplash() {
  if (splash && !splash.isDestroyed()) splash.destroy();
}

/** 唤醒既有窗口：主窗存在则恢复聚焦；仍在启动中则唤醒启动画面 */
function focusExistingWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else if (splash && !splash.isDestroyed()) {
    splash.show();
    splash.focus();
  }
}

// ==================== 失败处理 ====================

/** 启动失败统一出口：记录日志 → 清理自己 spawn 的进程 → 中文弹窗（可打开日志目录）→ 退出 */
async function failStartup(err) {
  if (failureHandled) return;
  failureHandled = true;
  const reason = err && err.message ? err.message : String(err);
  logLine(`启动失败: ${reason}`);
  killServer();
  killVite();
  destroySplash();
  try {
    const { response } = await dialog.showMessageBox({
      type: "error",
      title: "GiserAgent 启动失败",
      message: "GiserAgent 启动失败",
      detail: `${reason}\n\n日志文件:\n${logFile}`,
      buttons: ["打开日志目录", "退出"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) await shell.openPath(path.dirname(logFile));
  } finally {
    app.isQuitting = true;
    app.quit();
  }
}

// ==================== server 子进程 ====================

function killServer() {
  if (!serverOwned || !serverProc) {
    serverProc = null;
    return;
  }
  serverProcess.killProcessTree(serverProc);
  serverProc = null;
}

/** 在指定端口 spawn 本次自己的 server 并等待身份健康检查通过；失败清理后抛出 */
async function spawnAndWait(port) {
  logLine(`spawn server 子进程: 端口 ${port}（bundle 模式）`);
  const started = serverProcess.spawnServer({ rootDir: ROOT, isDev: false, port, logFile });
  serverProc = started.proc;
  serverOwned = true;
  try {
    await serverProcess.waitServerReady({
      proc: started.proc,
      port,
      timeoutMs: SERVER_START_TIMEOUT_MS,
      pollMs: HEALTH_POLL_MS,
      healthTimeoutMs: HEALTH_TIMEOUT_MS,
      tail: started.tail,
      state: started.state,
    });
    logLine(`server 就绪: 端口 ${port}（身份校验通过）`);
    return `http://127.0.0.1:${port}`;
  } catch (err) {
    killServer();
    throw err;
  } finally {
    if (!serverProc) serverOwned = false;
  }
}

/** 生产模式：先扫身份匹配且为 bundle 形态的已有实例（只复用不 kill），否则在空闲端口启动自己的 */
async function startProductionServer() {
  const scan = () =>
    serverProcess.findExistingServer({
      basePort: BASE_PORT,
      count: PORT_SCAN_COUNT,
      healthTimeoutMs: HEALTH_TIMEOUT_MS,
    });
  const existing = await scan();
  // 只复用 bundle 形态（托管 dist 的服务）；dev server（tsx 纯 API）身份虽匹配但加载会得到
  // 404，视为不可复用——跳过它并在下方端口循环里让位（绝不结束外部进程）
  if (existing && existing.mode === "bundle") {
    serverOwned = false;
    logLine(`复用已有 GiserAgent 服务: 端口 ${existing.port}`);
    return `http://127.0.0.1:${existing.port}`;
  }
  if (existing) {
    logLine(`端口 ${existing.port} 是 GiserAgent 开发服务（source 形态，不托管前端），不复用`);
  }

  let attempts = 0;
  let lastError = null;
  for (let port = BASE_PORT; port < BASE_PORT + PORT_SCAN_COUNT; port++) {
    if (await portOpen(port)) continue; // 被其他程序占用：跳过，绝不结束外部进程
    if (attempts >= MAX_SPAWN_ATTEMPTS) break;
    attempts++;
    try {
      return await spawnAndWait(port);
    } catch (err) {
      lastError = err;
      // 仅「端口被并发抢占（EADDRINUSE）」这类竞态换端口重试；其余失败直接抛给用户
      if (!(err && err.earlyExit && err.portTaken)) throw err;
      logLine(`端口 ${port} 被并发占用，换下一端口重试`);
    }
  }
  throw (
    lastError ||
    new Error(`在 ${BASE_PORT}-${BASE_PORT + PORT_SCAN_COUNT - 1} 端口范围内未找到可用端口。\n可设置环境变量 GISER_PORT 指定其他起始端口。`)
  );
}

// ==================== vite 子进程（dev 模式） ====================

let viteProc = null;
let viteOwned = false; // 是否拥有 vite 子进程；退出时只清理自己启动的（外部 vite 不动）

function killVite() {
  if (!viteOwned || !viteProc) {
    viteProc = null;
    return;
  }
  serverProcess.killProcessTree(viteProc);
  viteProc = null;
}

/**
 * dev 模式的前端服务器：5173 已有响应（外部 vite）则直接复用；否则由本进程
 * spawn vite（ELECTRON_RUN_AS_NODE 纯 Node 模式，与 server 同模式，不依赖系统 Node），
 * 带超时等就绪，提前退出即报错。前端与后端完全分离：Electron 与浏览器加载
 * 同一 vite 地址（HMR），改前端代码即时热更，不存在「Electron 版 / 浏览器版」。
 */
async function ensureViteServer() {
  try {
    await fetch(DEV_URL, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    logLine(`复用已运行的前端开发服务器: ${DEV_URL}`);
    return;
  } catch {
    /* 未运行，由本进程启动 */
  }
  const viteBin = path.resolve(__dirname, "..", "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteBin)) {
    throw new Error(`未找到 vite（${viteBin}）。请先在 frontend/ 执行 npm install。`);
  }
  logLine(`spawn vite 子进程（前端开发服务器，HMR）: ${DEV_URL}`);
  viteProc = spawn(process.execPath, [viteBin], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  viteOwned = true;
  let viteExited = false;
  viteProc.once("exit", () => {
    viteExited = true;
    if (!app.isQuitting) logLine("vite 子进程已退出");
  });
  viteProc.once("error", (err) => {
    logLine(`vite 子进程启动失败: ${err.message}`);
  });
  const forward = (chunk, name) => {
    const text = chunk.toString().trimEnd();
    if (text) serverProcess.appendLog(logFile, `[vite:${name}] ${text}`);
  };
  viteProc.stdout?.on("data", (c) => forward(c, "out"));
  viteProc.stderr?.on("data", (c) => forward(c, "err"));

  const deadline = Date.now() + DEV_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (viteExited) {
      viteOwned = false;
      viteProc = null;
      throw new Error(
        "vite 子进程提前退出（详见启动日志 [vite] 段）。请检查 frontend 依赖（npm --prefix frontend install）与 vite.config.ts。"
      );
    }
    try {
      await fetch(DEV_URL, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      logLine(`前端开发服务器就绪: ${DEV_URL}（改前端代码即时热更）`);
      return;
    } catch {
      /* 未就绪，继续等 */
    }
    await sleep(HEALTH_POLL_MS);
  }
  throw new Error(
    `vite 启动超时（${DEV_URL}，等待 ${Math.round(DEV_WAIT_TIMEOUT_MS / 1000)} 秒）。详见启动日志 [vite] 段。`
  );
}

/** 等外部 server 就绪（要求身份匹配）；超时报错交给 failStartup */
async function waitExternalServer() {
  const deadline = Date.now() + DEV_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { identity } = await serverProcess.fetchHealth(BASE_PORT, HEALTH_TIMEOUT_MS);
    if (identity) {
      logLine(`检测到 GiserAgent 后端服务: 端口 ${BASE_PORT}（身份校验通过）`);
      return;
    }
    await sleep(HEALTH_POLL_MS);
  }
  throw new Error(
    `开发模式：未检测到 GiserAgent 后端服务（127.0.0.1:${BASE_PORT}，等待 ${Math.round(DEV_WAIT_TIMEOUT_MS / 1000)} 秒）。\n` +
      `请先在 server/ 运行 npm run dev；若该端口被其他程序占用，请设置环境变量 GISER_PORT 换端口。`
  );
}

// ==================== 主窗口 ====================

/** 图标等自带资源目录：开发态 electron/build，打包后 resources/desktop-build */
function desktopResourceDir() {
  const devDir = path.join(__dirname, "build");
  if (fs.existsSync(path.join(devDir, "icon.ico"))) return devDir;
  return path.join(process.resourcesPath || __dirname, "desktop-build");
}

async function createWindow(url) {
  win = new BrowserWindow({
    ...WINDOW_OPTS,
    autoHideMenuBar: true,
    title: "GiserAgent",
    show: false, // 首帧就绪再显示，避免白屏/黑屏闪烁
    // 应用图标（任务栏/标题栏；打包后以 exe 图标为准）
    icon: path.join(desktopResourceDir(), "icon.ico"),
    // 无边框一体化：标题栏由前端顶栏承担（拖拽区 + 内置窗口控制按钮，见 preload.cjs）
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const showWin = () => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.once("ready-to-show", showWin);
  win.webContents.once("did-finish-load", () => {
    showWin();
    closeSplash(); // 主窗就绪后关闭启动画面
  });
  win.on("maximize", () => win?.webContents.send("win:maximized-changed", true));
  win.on("unmaximize", () => win?.webContents.send("win:maximized-changed", false));
  // 首次加载失败（非主动取消的 ERR_ABORTED）→ 弹窗退出
  win.webContents.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = ERR_ABORTED，多为主动取消
    failStartup(new Error(`页面加载失败（错误码 ${code} ${desc}）: ${url}`)).catch(() => {});
  });
  // 托盘常驻：✕ 只隐藏窗口；真正退出走托盘菜单（isQuitting 标志放行销毁）
  win.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });

  try {
    await win.loadURL(url);
  } catch (err) {
    // did-fail-load 之外的异常路径（如窗口已被销毁），避免静默卡屏
    if (!failureHandled && win && !win.isDestroyed()) {
      await failStartup(new Error(`页面加载失败: ${url}\n${err.message}`)).catch(() => {});
    }
  }
}

// ==================== 系统托盘 ====================

/** 系统托盘：关窗仅隐藏，从这里才能真正退出（结束本次拥有的 server 子进程） */
function createTray() {
  const iconPath = path.join(desktopResourceDir(), "logo.png");
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 32, height: 32 }));
  tray.setToolTip("GiserAgent（单击显示/隐藏，右键菜单退出）");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示主窗口",
        click: () => focusExistingWindow(),
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          app.isQuitting = true;
          killServer(); // 只结束本次自己 spawn 的 server/vite，复用的外部实例不受影响
          killVite();
          tray?.destroy();
          app.quit();
        },
      },
    ])
  );
  // 单击托盘：主窗可见则隐藏，否则显示
  tray.on("click", () => {
    if (!win || win.isDestroyed()) return;
    if (win.isVisible() && win.isFocused()) win.hide();
    else focusExistingWindow();
  });
}

// ==================== 窗口控制 IPC（无边框窗口） ====================

ipcMain.handle("win:minimize", () => win?.minimize());
ipcMain.handle("win:toggle-maximize", () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});
ipcMain.handle("win:close", () => win?.close());

// 原生目录选择（新建项目等场景）；返回所选目录绝对路径，取消返回 null
ipcMain.handle("dialog:pick-directory", async () => {
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: "选择项目文件夹",
    properties: ["openDirectory"],
  });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});

// 在系统资源管理器中打开目录（会话目录定位等）
ipcMain.handle("shell:open-path", (_e, target) => shell.openPath(String(target)));

// ==================== 启动编排 ====================

async function bootstrap() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  // 第二次启动：唤醒现有主窗；主窗未建（仍在启动/已隐藏）时唤醒启动画面
  app.on("second-instance", () => focusExistingWindow());

  await app.whenReady();

  // 日志目录：userData/logs（不改动 userData 身份，沿用应用默认）
  const logDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  logFile = path.join(logDir, "startup.log");
  logLine(`GiserAgent 桌面端启动: mode=${IS_DEV ? "dev" : "production"} 端口段=${BASE_PORT}-${BASE_PORT + PORT_SCAN_COUNT - 1}`);

  splash = createSplash();

  try {
    let url;
    if (IS_DEV) {
      await ensureViteServer();
      await waitExternalServer();
      url = DEV_URL;
    } else {
      url = await startProductionServer();
    }
    if (failureHandled) return;
    await createWindow(url);
    if (!failureHandled) createTray();
  } catch (err) {
    await failStartup(err);
  }
}

app.on("before-quit", () => {
  // 任何来源的退出（托盘/系统关机/second-instance 退出）都放行 close 并清理本次进程
  app.isQuitting = true;
  killServer();
  killVite();
});

bootstrap().catch((err) => failStartup(err).catch(() => app.quit()));

process.on("exit", () => {
  killServer();
  killVite();
});
