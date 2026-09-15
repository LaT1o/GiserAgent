/**
 * GiserAgent 桌面 preload。
 *
 * 无边框窗口（frame: false）下，前端顶栏内置的最小化/最大化/关闭按钮
 * 经此桥接操作主进程窗口；contextIsolation 保持开启，仅暴露最小 API。
 * 浏览器直接访问（无 preload 注入）时 window.giserDesktop 为 undefined，
 * 前端据此隐藏窗口控制按钮。
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("giserDesktop", {
  minimize: () => ipcRenderer.invoke("win:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("win:toggle-maximize"),
  close: () => ipcRenderer.invoke("win:close"),
  /** 原生目录选择（新建项目等）：返回所选绝对路径，取消返回 null */
  pickDirectory: () => ipcRenderer.invoke("dialog:pick-directory"),
  /** 在系统资源管理器中打开目录 */
  openPath: (path) => ipcRenderer.invoke("shell:open-path", path),
  /** 订阅最大化状态变化（用于还原/最大化图标切换），返回取消函数 */
  onMaximizeChange: (cb) => {
    const listener = (_e, maximized) => cb(maximized);
    ipcRenderer.on("win:maximized-changed", listener);
    return () => ipcRenderer.removeListener("win:maximized-changed", listener);
  },
});
