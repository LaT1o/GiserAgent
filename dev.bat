@echo off
rem GiserAgent dev launcher. This file is UTF-8 (no BOM).
rem Pass 1 keeps ASCII only: switch console to UTF-8, then re-enter this file.
rem cmd mis-parses multibyte batch files when chcp happens mid-file, so the
rem Chinese body below must only be read after the console is already UTF-8.
if not "%~1"=="__utf8__" (
  chcp 65001 >nul
  call "%~f0" __utf8__
  exit /b
)

rem ==== 以下正文在 UTF-8 控制台下执行 ====
cd /d "%~dp0"

echo ==================================================
echo   GiserAgent：一个后端 + 一个前端（桌面窗口）
echo ==================================================
echo.

if not exist "server\node_modules" (
  echo [错误] 缺少 server\node_modules，请先在仓库根执行：
  echo     npm --prefix server install
  echo.
  echo 按任意键关闭本窗口...
  pause >nul
  exit /b 1
)
if not exist "frontend\node_modules" (
  echo [错误] 缺少 frontend\node_modules，请先在仓库根执行：
  echo     npm --prefix frontend install
  echo.
  echo 按任意键关闭本窗口...
  pause >nul
  exit /b 1
)

echo 正在启动后端（0.0.0.0:3001，tsx 源码热更）与前端桌面窗口（Electron 内嵌 vite，改前端代码即时热更）...
start "GiserAgent 后端 (server)" cmd /k "npm --prefix server run dev"
start "GiserAgent 桌面窗口 (electron)" cmd /k "npm --prefix frontend run electron:dev"

echo.
echo 浏览器访问: http://localhost:5173（与桌面窗口同一前端，/api 自动代理到后端）
echo 说明: 改前端代码 vite 即时热更，无需构建；
echo       改后端代码 tsx 自动重启，SSE 3 秒内自动重连，桌面窗口无需刷新
echo       （重启瞬间正在执行的任务会中断，完成后刷新窗口可重建完整记录）。
echo 停止方式: 关闭两个终端窗口（桌面窗口也可从托盘「退出」，会一并结束其 vite）
echo.
echo 按任意键关闭本窗口...
pause >nul
