/**
 * 桌面窗口桥接类型（desktop/preload.cjs 注入）。
 * 浏览器直接访问（无 Electron preload）时 window.giserDesktop 为 undefined，
 * 界面据此隐藏窗口控制按钮并保持纯 web 行为。
 */

export {};

declare global {
  interface Window {
    giserDesktop?: {
      minimize: () => Promise<void>;
      /** 切换最大化/还原，返回切换后的最大化状态 */
      toggleMaximize: () => Promise<boolean>;
      close: () => Promise<void>;
      /** 原生目录选择（新建项目等）：返回所选绝对路径，取消返回 null */
      pickDirectory: () => Promise<string | null>;
      /** 在系统资源管理器中打开目录 */
      openPath: (path: string) => Promise<void>;
      /** 订阅最大化状态变化，返回取消订阅函数 */
      onMaximizeChange: (cb: (maximized: boolean) => void) => () => void;
    };
    /** File System Access API（Chromium 浏览器环境的目录选择兜底） */
    showDirectoryPicker?: () => Promise<{ name: string } | undefined>;
  }
}
