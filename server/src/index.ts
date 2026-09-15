/**
 * 服务入口（composition root）：
 * 本文件是全项目唯一同时知道"配置、具体 Adapter 实现、业务层"的地方。
 * 其余模块只依赖抽象（AgentAdapter 接口）。
 */

import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { PROJECT_DIR, loadConfig } from "./config.js";
import { SettingsStore } from "./settings.js";
import { ProjectStore } from "./projects.js";
import { createPiAdapter } from "./agent/pi/piAdapter.js";
import { DATA_TIMEOUT_SECONDS, runToolbox } from "./agent/pi/extensions/toolbox.js";
import { SessionService } from "./application/sessionService.js";
import { MapService } from "./application/mapService.js";
import { registerRoutes } from "./api/routes.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const settingsStore = new SettingsStore(config.workspaceDir);
  const projectStore = new ProjectStore(config.workspaceDir);

  const adapter = createPiAdapter(config, () => settingsStore.get(), {
    // 注册项目的会话与地图数据存入项目内 .latio（扫描时也需知道项目根清单）
    projectPaths: () => projectStore.list().map((p) => p.path),
  });
  const service = new SessionService(adapter, projectStore, config.workspaceDir);
  const mapService = new MapService(projectStore, config.pythonExecutable);

  const app = Fastify({
    logger: false,
    // 矢量数据拖拽上传走 multipart，单文件/总量限制在下文 multipart 配置里
    bodyLimit: 512 * 1024 * 1024,
  });

  // 矢量数据上传（拖拽上图）：multipart 表单，单文件与总量上限 512MB。
  // preservePath：保留 filename 中的相对路径（gdb 目录逐文件上传、shp sidecar 分组依赖它）
  await app.register(fastifyMultipart, {
    limits: { fileSize: 512 * 1024 * 1024, files: 200 },
    preservePath: true,
  });

  // 运行形态：tsx 源码直跑（纯 API，前端走 vite）还是 bundle 构建产物（托管 frontend/dist）。
  // health 透出给 Electron 壳：生产壳只复用 bundle 形态（source 形态加载会得到 404）
  const runningFromSource = process.argv[1]?.endsWith(".ts") ?? false;

  // 健康检查（前端启动探活约定：status + app 标识 + 运行形态）
  app.get("/api/health", async () => ({ status: "ok", app: "GiserAgent", mode: runningFromSource ? "source" : "bundle" }));

  // 工具箱 inspect 工厂：拖拽上传登记时按读取基准目录构造 inspect（保持 api 层不依赖 Agent Runtime）
  const inspectFactory = (cwd: string) => async (input: { path: string; layer?: string; output: string }) => {
    const entry = await runToolbox(config.pythonExecutable, cwd, "inspect", input, undefined, DATA_TIMEOUT_SECONDS);
    return (entry.result as never) ?? { success: false, error: entry.run.stderr.slice(-500) };
  };
  registerRoutes(app, service, settingsStore, projectStore, mapService, inspectFactory);

  // 前端构建产物仅在 bundle 运行形态（build/server.mjs：electron:start / 打包安装版）托管；
  // tsx 源码直跑（npm run dev）恒为纯 API，前端走 vite 5173——避免开发期浏览器误开
  // 13001 看到旧构建页面（需要在源码形态临时托管 dist 验证时设 GISER_SERVE_DIST=1）
  if (process.env.GISER_SERVE_DIST || !runningFromSource) {
    const frontendDist = resolve(PROJECT_DIR, "frontend", "dist");
    if (existsSync(frontendDist)) {
      await app.register(fastifyStatic, { root: frontendDist, wildcard: false });
      console.log(`[server] 前端静态托管已启用: ${frontendDist}`);
      // SPA 回退：非 /api 的未知路径返回 index.html
      app.setNotFoundHandler((req, reply) => {
        if (req.raw.url?.startsWith("/api")) {
          return reply.code(404).send({ error: "Not Found" });
        }
        return reply.sendFile("index.html");
      });
    }
  }

  // 监听地址默认 0.0.0.0（便于局域网/端口映射穿透访问同一前端）；仅本机使用可设 GISER_HOST=127.0.0.1
  // 注意：API 无鉴权，暴露到不可信网络前请自行加防火墙/反向代理规则
  const port = config.port;
  const host = process.env.GISER_HOST || "0.0.0.0";
  await app.listen({ port, host });
  console.log(`[server] GiserAgent API 已启动: http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}（监听 ${host}）`);
  const defaultModel = service.resolveDefaultModel();
  console.log(
    defaultModel
      ? `[server] adapter=${config.adapter} 默认模型=${defaultModel.providerId}/${defaultModel.modelId}`
      : `[server] adapter=${config.adapter} 尚未配置模型提供商（请在界面“设置 → 模型提供商”中添加）`
  );

  // 优雅退出：关闭会话与 HTTP 服务
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] 收到 ${signal}，正在关闭所有 Agent 会话...`);
    try {
      await app.close();
      await service.dispose();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
    // listen 错误自带实际冲突端口（err.port），无需依赖 main() 内的 config
    const port = (err as NodeJS.ErrnoException & { port?: number }).port ?? "配置的";
    console.error(`[server] 启动失败: 端口 ${port} 已被占用（可能有旧实例未退出）。`);
    console.error(
      `[server] 排查: netstat -ano | findstr :${port} 找到占用 PID 后 taskkill /PID <PID> /F 结束它，` +
        `或在 server/.env 中设置 PORT 换端口后重试。`
    );
  } else {
    console.error("[server] 启动失败:", err);
  }
  process.exit(1);
});
