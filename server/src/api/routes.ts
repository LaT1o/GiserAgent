/**
 * Application API 路由（薄层，只做参数解析与 HTTP 语义）。
 *
 * 依赖方向：api → application（SessionService）/ settings / projects / providers。
 * 本文件不 import 任何 Agent Runtime 相关模块。
 */

import { createWriteStream, mkdirSync, readdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import type { SessionService, SessionNotFoundError } from "../application/sessionService.js";
import type { SessionPermissions, ThinkingLevel } from "../agent/session.js";
import type { SettingsStore } from "../settings.js";
import type { ProjectStore } from "../projects.js";
import {
  ensureLatioLayout,
  ingestUploadedVectorFiles,
  MapLayerStore,
  type InspectVectorInfo,
  type MapLayer,
} from "../webgis.js";
import type { MapService } from "../application/mapService.js";
import { fetchUpstreamModels } from "../providers.js";

/** 工具箱 inspect 的注入实现（由 index.ts 用便携 Python + runToolbox 构造后传入，保持本层不依赖 Agent Runtime） */
export type InspectRunner = (input: { path: string; layer?: string; output: string }) => Promise<InspectVectorInfo>;

interface MessageBody {
  text?: unknown;
  images?: unknown;
}

interface CreateSessionBody {
  projectPath?: unknown;
  projectId?: unknown;
  /** 临时会话：不进列表，首条用户消息后转为正式会话 */
  draft?: unknown;
}

const PERMISSION_SCOPES = ["off", "project", "all"] as const;
const APPROVAL_MODES = ["ask", "smart", "full"] as const;
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 统一错误映射：会话/项目/图层不存在 → 404，其余业务错误 → 409 */
function errorStatus(err: unknown): 404 | 409 {
  if ((err as { statusCode?: number }).statusCode === 404) return 404;
  return (err as SessionNotFoundError).sessionId !== undefined ? 404 : 409;
}

/** 目录浏览：path 为空列 Windows 盘符，否则列出该目录下的子目录（本地单用户应用） */
function listDirectories(path: string | undefined): Array<{ name: string; path: string; parent: string | null }> {
  if (!path) {
    const drives: Array<{ name: string; path: string; parent: null }> = [];
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      const drive = `${letter}:\\`;
      try {
        readdirSync(drive);
        drives.push({ name: `${letter}:`, path: drive, parent: null });
      } catch {
        // 不存在或不可读的盘符跳过
      }
    }
    return drives;
  }
  const target = resolve(path);
  if (!isAbsolute(target)) throw new Error("path 需为绝对路径");
  const entries = readdirSync(target, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 500);
  const parent = resolve(target, "..");
  return entries.map((e) => ({
    name: e.name,
    path: `${target.endsWith(sep) ? target : target + sep}${e.name}`,
    parent: parent.length < target.length ? parent : null,
  }));
}

export function registerRoutes(
  app: FastifyInstance,
  service: SessionService,
  settingsStore?: SettingsStore,
  projectStore?: ProjectStore,
  mapService?: MapService,
  /** 工具箱 inspect 工厂：按读取基准目录构造 inspect 实现（拖拽上传登记用） */
  inspectFactory?: (cwd: string) => InspectRunner
): void {
  /** 共享的拖拽上传登记：multipart 落盘到 webgis/uploads/<stamp>，再批量登记为图层 */
  async function handleUpload(
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
    context: { webgisDir: string; pythonExecutable: string; cwd: string; sessionId: string }
  ) {
    if (!inspectFactory) return reply.code(500).send({ error: "上传登记未初始化" });
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const uploadedRoot = resolve(context.webgisDir, "uploads", stamp);
    mkdirSync(uploadedRoot, { recursive: true });
    const filenames: string[] = [];
    let totalBytes = 0;
    const MAX_TOTAL = 512 * 1024 * 1024;
    try {
      for await (const part of req.files()) {
        const rawName = (part.filename || "").replace(/\\/g, "/").replace(/^\/+/, "");
        if (!rawName) continue;
        // 防目录穿越：去掉 .. 段，落到 uploadedRoot 内
        const safeRel = rawName.split("/").filter((seg) => seg && seg !== "." && seg !== "..").join("/");
        if (!safeRel) continue;
        const dest = resolve(uploadedRoot, safeRel);
        if (dest !== uploadedRoot && !dest.startsWith(uploadedRoot + sep)) continue;
        mkdirSync(resolve(dest, ".."), { recursive: true });
        await pipeline(part.file, createWriteStream(dest));
        totalBytes += part.file.bytesRead ?? 0;
        if (totalBytes > MAX_TOTAL) {
          return reply.code(413).send({ error: "上传总量超过 512MB 上限" });
        }
        filenames.push(safeRel);
      }
    } catch (err) {
      return reply.code(400).send({ error: `接收上传文件失败: ${(err as Error).message}` });
    }
    if (!filenames.length) return reply.code(400).send({ error: "未收到任何文件" });

    const store = new MapLayerStore(context.webgisDir);
    store.ensureDirs();
    const inspect = inspectFactory(context.cwd);
    const { results, ignored } = await ingestUploadedVectorFiles({
      store,
      sessionId: context.sessionId,
      uploadedRoot,
      filenames,
      inspect,
      sourceTool: "map_upload",
    });
    const ok = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    return {
      success: ok.length > 0,
      uploaded: filenames.length,
      layers: ok.map((r) => r.layer),
      failed: failed.map((r) => ({ dataset: r.dataset, mainFile: r.mainFile, error: r.error })),
      ignored,
      note: "图层已登记，前端地图面板会自动刷新",
    };
  }

  /** 应用设置（默认模型/压缩百分比）：resolvedDefaultModel 为当前解析出的默认模型
   *  （用户设置优先 → 首个提供商首个模型；未配置提供商时为 null） */
  app.get("/api/settings", async () => ({
    settings: settingsStore ? settingsStore.get() : null,
    resolvedDefaultModel: service.resolveDefaultModel(),
  }));
  app.put("/api/settings", async (req, reply) => {
    if (!settingsStore) return reply.code(500).send({ error: "settings 存储未初始化" });
    return { settings: settingsStore.update(req.body) };
  });

  /** 全部可用模型（models.json 解析结果） */
  app.get("/api/models", async () => ({ models: await service.listModels() }));

  /** 模型提供商管理（models.json + auth.json，密钥只落 auth.json） */
  app.get("/api/providers", async () => ({ providers: await service.listProviders() }));

  app.post("/api/providers", async (req, reply) => {
    const body = (req.body ?? {}) as { id?: unknown; name?: unknown; baseUrl?: unknown; api?: unknown; apiKey?: unknown };
    if (typeof body.id !== "string" || !body.id.trim() || typeof body.baseUrl !== "string" || !body.baseUrl.trim()) {
      return reply.code(400).send({ error: "请求体需包含字符串字段 id 与 baseUrl（可选 name/api/apiKey）" });
    }
    try {
      const provider = await service.addProvider({
        id: body.id,
        ...(typeof body.name === "string" && body.name.trim() ? { name: body.name } : {}),
        baseUrl: body.baseUrl,
        ...(typeof body.api === "string" && body.api.trim() ? { api: body.api } : {}),
        ...(typeof body.apiKey === "string" && body.apiKey ? { apiKey: body.apiKey } : {}),
      });
      reply.code(201);
      return { provider };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  app.delete("/api/providers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    // 应用默认模型指向该 provider 时先行清理：adapter 仅持有 settings 只读回调，
    // 先清才能让 removeProvider 内部把受影响会话切到正确的剩余默认模型
    if (settingsStore && settingsStore.get().defaultModel?.providerId === id) {
      settingsStore.update({ defaultModel: null });
    }
    try {
      await service.removeProvider(id);
      reply.code(202);
      return { accepted: true };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 编辑提供商：{ name?, baseUrl?, apiKey? }（apiKey 仅填写时覆盖） */
  app.put("/api/providers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: unknown; baseUrl?: unknown; apiKey?: unknown };
    const hasField =
      (typeof body.name === "string" && body.name.trim()) ||
      (typeof body.baseUrl === "string" && body.baseUrl.trim()) ||
      (typeof body.apiKey === "string" && body.apiKey);
    if (!hasField) {
      return reply.code(400).send({ error: "请求体至少包含 name / baseUrl / apiKey 之一" });
    }
    try {
      const provider = await service.updateProvider(id, {
        ...(typeof body.name === "string" && body.name.trim() ? { name: body.name } : {}),
        ...(typeof body.baseUrl === "string" && body.baseUrl.trim() ? { baseUrl: body.baseUrl } : {}),
        ...(typeof body.apiKey === "string" && body.apiKey ? { apiKey: body.apiKey } : {}),
      });
      return { provider };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 删除提供商下指定模型：{ providerId, modelIds: string[] } */
  app.post("/api/providers/remove-models", async (req, reply) => {
    const body = (req.body ?? {}) as { providerId?: unknown; modelIds?: unknown };
    if (typeof body.providerId !== "string" || !Array.isArray(body.modelIds) || !body.modelIds.length) {
      return reply.code(400).send({ error: "请求体需包含字符串字段 providerId 与非空数组 modelIds" });
    }
    try {
      const provider = await service.removeModels(body.providerId, body.modelIds.filter((m): m is string => typeof m === "string"));
      return { provider };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 全局技能列表（设置页 Skills 管理） */
  app.get("/api/skills", async () => ({ skills: await service.listGlobalSkills() }));

  /** 技能启用/禁用开关：{ name, disabled }（写 settings.disabledSkills，会话技能加载过滤） */
  app.put("/api/skills/disabled", async (req, reply) => {
    if (!settingsStore) return reply.code(500).send({ error: "settings 存储未初始化" });
    const body = (req.body ?? {}) as { name?: unknown; disabled?: unknown };
    if (typeof body.name !== "string" || !body.name.trim() || typeof body.disabled !== "boolean") {
      return reply.code(400).send({ error: "请求体需包含字符串字段 name 与布尔字段 disabled" });
    }
    const name = body.name.trim();
    const current = new Set(settingsStore.get().disabledSkills ?? []);
    if (body.disabled) current.add(name);
    else current.delete(name);
    settingsStore.update({ disabledSkills: [...current] });
    return { accepted: true, disabledSkills: [...current] };
  });

  app.delete("/api/skills", async (req, reply) => {
    const body = (req.body ?? {}) as { path?: unknown };
    if (typeof body.path !== "string" || !body.path.trim()) {
      return reply.code(400).send({ error: "请求体需包含字符串字段 path" });
    }
    try {
      await service.deleteGlobalSkill(body.path.trim());
      reply.code(202);
      return { accepted: true };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 向提供商导入模型条目：{ providerId, models: [{id, name?, reasoning?...}] } */
  app.post("/api/providers/import-models", async (req, reply) => {
    const body = (req.body ?? {}) as { providerId?: unknown; models?: unknown };
    if (typeof body.providerId !== "string" || !Array.isArray(body.models) || !body.models.length) {
      return reply.code(400).send({ error: "请求体需包含字符串字段 providerId 与非空数组 models" });
    }
    const models: Array<{
      id: string;
      name?: string;
      input?: string[];
      contextWindow?: number;
      maxTokens?: number;
      reasoning?: boolean;
      thinkingLevelMap?: Record<string, string | null>;
    }> = [];
    for (const item of body.models) {
      const m = item as Record<string, unknown>;
      if (typeof m?.id !== "string" || !m.id.trim()) {
        return reply.code(400).send({ error: "models 每项需包含字符串字段 id" });
      }
      // 思考档位映射：值为上游原生档位名（字符串）或 null（显式不支持该档）
      let thinkingLevelMap: Record<string, string | null> | undefined;
      if (m.thinkingLevelMap !== undefined) {
        if (typeof m.thinkingLevelMap !== "object" || m.thinkingLevelMap === null || Array.isArray(m.thinkingLevelMap)) {
          return reply.code(400).send({ error: "thinkingLevelMap 需为对象（值为字符串或 null）" });
        }
        thinkingLevelMap = {};
        for (const [level, mapped] of Object.entries(m.thinkingLevelMap as Record<string, unknown>)) {
          if (mapped !== null && typeof mapped !== "string") {
            return reply.code(400).send({ error: `thinkingLevelMap.${level} 需为字符串或 null` });
          }
          thinkingLevelMap[level] = mapped;
        }
      }
      models.push({
        id: m.id,
        ...(typeof m.name === "string" && m.name.trim() ? { name: m.name } : {}),
        ...(Array.isArray(m.input) ? { input: m.input as string[] } : {}),
        ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
        ...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
        ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
        ...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
      });
    }
    try {
      return { provider: await service.importModels(body.providerId, models) };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 探测上游模型列表（OpenAI 兼容 GET {baseUrl}/models，仅探测不落盘；apiKey 缺省时可用 providerId 的已存密钥） */
  app.post("/api/providers/fetch-upstream", async (req, reply) => {
    const body = (req.body ?? {}) as { baseUrl?: unknown; apiKey?: unknown; providerId?: unknown };
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
    const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
    if (!baseUrl) {
      return reply.code(400).send({ error: "请求体需包含字符串字段 baseUrl（必填）及 apiKey 或 providerId 之一" });
    }
    let key = apiKey;
    if (!key && providerId) {
      key = service.getStoredApiKey(providerId) ?? "";
      if (!key) {
        return reply.code(400).send({ error: `提供商 ${providerId} 尚未保存 API Key，请填写后再获取` });
      }
    }
    if (!key) {
      return reply.code(400).send({ error: "请求体需包含 apiKey，或提供 providerId 以使用已保存密钥" });
    }
    try {
      const models = await fetchUpstreamModels(baseUrl, key);
      return { models };
    } catch (err) {
      return reply.code(502).send({ error: `上游模型列表获取失败: ${(err as Error).message}` });
    }
  });

  /** 项目实体管理（workspace/projects.json） */
  app.get("/api/projects", async () => ({ projects: projectStore ? projectStore.list() : [] }));

  app.post("/api/projects", async (req, reply) => {
    if (!projectStore) return reply.code(500).send({ error: "projects 存储未初始化" });
    const body = (req.body ?? {}) as { name?: unknown; path?: unknown };
    if (typeof body.path !== "string" || !body.path.trim()) {
      return reply.code(400).send({ error: "请求体需包含字符串字段 path（可选 name）" });
    }
    try {
      const project = projectStore.create(
        typeof body.name === "string" ? body.name : "",
        body.path.trim()
      );
      try {
        // 项目内存储初始化（.latio：会话 + 地图制品 + 临时数据；Windows 下点目录不自动隐藏）
        ensureLatioLayout(project.path, project.name);
      } catch (err) {
        // 初始化失败不留半可用条目：回滚注册，避免"已登记但不可用"
        projectStore.delete(project.id);
        throw new Error(`项目内 .latio 初始化失败: ${(err as Error).message}`);
      }
      reply.code(201);
      return { project };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post("/api/projects/reorder", async (req, reply) => {
    if (!projectStore) return reply.code(500).send({ error: "projects 存储未初始化" });
    const body = (req.body ?? {}) as { orderedIds?: unknown };
    if (!Array.isArray(body.orderedIds) || body.orderedIds.some((v) => typeof v !== "string")) {
      return reply.code(400).send({ error: "请求体需包含字符串数组字段 orderedIds" });
    }
    projectStore.reorder(body.orderedIds as string[]);
    reply.code(202);
    return { accepted: true };
  });

  app.patch("/api/projects/:id", async (req, reply) => {
    if (!projectStore) return reply.code(500).send({ error: "projects 存储未初始化" });
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: unknown };
    if (typeof body.name !== "string" || !body.name.trim()) {
      return reply.code(400).send({ error: "请求体需包含非空字符串字段 name" });
    }
    try {
      return { project: projectStore.rename(id, body.name.trim()) };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  app.delete("/api/projects/:id", async (req, reply) => {
    if (!projectStore) return reply.code(500).send({ error: "projects 存储未初始化" });
    const { id } = req.params as { id: string };
    try {
      projectStore.delete(id);
      reply.code(202);
      return { accepted: true };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 目录浏览（创建项目选路径用）：?path=<绝对路径>，缺省列盘符 */
  app.get("/api/fs/dirs", async (req, reply) => {
    const { path } = req.query as { path?: string };
    try {
      return { entries: listDirectories(path) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post("/api/sessions", async (req, reply) => {
    const body = (req.body ?? {}) as CreateSessionBody;
    const input: { projectPath?: string; projectId?: string; draft?: boolean } = {};
    if (typeof body.projectId === "string" && body.projectId.trim()) {
      input.projectId = body.projectId.trim();
    } else if (typeof body.projectPath === "string" && body.projectPath.trim()) {
      input.projectPath = body.projectPath.trim();
    }
    if (body.draft === true) input.draft = true;
    try {
      const session = await service.createSession(Object.keys(input).length ? input : undefined);
      reply.code(201);
      return { session };
    } catch (err) {
      // 项目路径不存在等创建参数错误
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** trash=1 时返回回收站（软删除）会话 */
  app.get("/api/sessions", async (req) => {
    const { trash } = req.query as { trash?: string };
    const sessions = await service.listSessions({ includeDeleted: trash === "1" });
    return { sessions: trash === "1" ? sessions.filter((s) => s.deletedAt) : sessions };
  });

  /** 清空回收站：彻底删除全部已软删会话（单个失败不中断，返回成功/失败数） */
  app.post("/api/sessions/trash/clear", async (req, reply) => {
    const deleted = (await service.listSessions({ includeDeleted: true })).filter((s) => s.deletedAt);
    let purged = 0;
    let failed = 0;
    for (const session of deleted) {
      try {
        await service.purgeSession(session.id);
        purged += 1;
      } catch {
        failed += 1;
      }
    }
    reply.code(202);
    return { accepted: true, purged, failed };
  });

  app.get("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await service.getSession(id);
    if (!session) return reply.code(404).send({ error: `会话不存在: ${id}` });
    return { session };
  });

  /** 重命名 / 置顶：{ title? , pinned? }（至少其一） */
  app.patch("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { title?: unknown; pinned?: unknown };
    const hasTitle = typeof body.title === "string" && body.title.trim().length > 0;
    const hasPinned = typeof body.pinned === "boolean";
    if (!hasTitle && !hasPinned) {
      return reply.code(400).send({ error: "请求体需包含非空字符串 title 或布尔 pinned" });
    }
    try {
      if (!(await service.getSession(id))) {
        return reply.code(404).send({ error: `会话不存在: ${id}` });
      }
      let session = await service.getSession(id);
      if (hasTitle) session = await service.renameSession(id, (body.title as string).trim());
      if (hasPinned) session = await service.toggleSessionPin(id, body.pinned as boolean);
      return { session };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 手动排序：{ orderedIds: [...] }（侧栏拖动排序持久化） */
  app.post("/api/sessions/reorder", async (req, reply) => {
    const body = (req.body ?? {}) as { orderedIds?: unknown };
    if (!Array.isArray(body.orderedIds) || body.orderedIds.some((v) => typeof v !== "string")) {
      return reply.code(400).send({ error: "请求体需包含字符串数组字段 orderedIds" });
    }
    await service.reorderSessions(body.orderedIds as string[]);
    reply.code(202);
    return { accepted: true };
  });

  /** 软删除（移入回收站）；purge=1 彻底删除整个会话目录 */
  app.delete("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { purge } = req.query as { purge?: string };
    try {
      if (purge === "1") {
        await service.purgeSession(id);
      } else {
        await service.deleteSession(id);
      }
      reply.code(202);
      return { accepted: true };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 从回收站恢复 */
  app.post("/api/sessions/:id/restore", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { session: await service.restoreSession(id) };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 切换 plan/act 模式：{ mode: "plan" | "act" } */
  app.post("/api/sessions/:id/mode", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { mode?: unknown };
    if (body?.mode !== "plan" && body?.mode !== "act") {
      return reply.code(400).send({ error: '请求体需包含字段 mode，取值 "plan" 或 "act"' });
    }
    try {
      return { session: await service.setMode(id, body.mode) };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 更新读写权限：{ permissions: { read, write, bash, approval, web, mcp } } */
  app.post("/api/sessions/:id/permissions", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { permissions?: unknown };
    const p = body?.permissions as Partial<SessionPermissions> | undefined;
    if (
      !p ||
      !PERMISSION_SCOPES.includes(p.read as (typeof PERMISSION_SCOPES)[number]) ||
      !PERMISSION_SCOPES.includes(p.write as (typeof PERMISSION_SCOPES)[number]) ||
      typeof p.bash !== "boolean" ||
      (p.approval !== undefined && !APPROVAL_MODES.includes(p.approval as (typeof APPROVAL_MODES)[number])) ||
      typeof p.web !== "boolean" ||
      typeof p.mcp !== "boolean"
    ) {
      return reply.code(400).send({
        error:
          "请求体需包含 permissions 对象：read/write ∈ off|project|all，bash/web/mcp 为布尔值，approval ∈ ask|smart|full（可选）",
      });
    }
    try {
      return {
        session: await service.setPermissions(id, {
          read: p.read as SessionPermissions["read"],
          write: p.write as SessionPermissions["write"],
          bash: p.bash,
          approval: (p.approval as SessionPermissions["approval"]) ?? "ask",
          web: p.web,
          mcp: p.mcp,
        }),
      };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 事件历史（events.jsonl 回放）：?after=<seq> 返回 seq 更大的记录 */
  app.get("/api/sessions/:id/history", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { after } = req.query as { after?: string };
    if (!(await service.getSession(id))) {
      return reply.code(404).send({ error: `会话不存在: ${id}` });
    }
    const afterSeq = after !== undefined ? Number(after) : 0;
    const records = await service.history(id, Number.isFinite(afterSeq) ? afterSeq : 0);
    return { records };
  });

  app.post("/api/sessions/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as MessageBody;
    if (typeof body.text !== "string" || !body.text.trim()) {
      return reply.code(400).send({ error: "请求体需包含非空字符串字段 text" });
    }
    // 可选图片附件：[{ data: base64, mimeType }]，仅多模态模型可用
    let images: { data: string; mimeType: string }[] | undefined;
    if (Array.isArray(body.images) && body.images.length) {
      const parsed: { data: string; mimeType: string }[] = [];
      for (const img of body.images) {
        const item = img as { data?: unknown; mimeType?: unknown };
        if (typeof item?.data !== "string" || typeof item?.mimeType !== "string") {
          return reply.code(400).send({ error: "images 数组每项需包含字符串字段 data(base64) 与 mimeType" });
        }
        parsed.push({ data: item.data, mimeType: item.mimeType });
      }
      images = parsed;
    }
    try {
      const seq = await service.sendMessage(id, body.text, images);
      reply.code(202);
      return { accepted: true, seq };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 编辑历史用户消息并原地重发：{ seq, text }（其后轨迹被替换，运行中会话拒绝） */
  app.post("/api/sessions/:id/edit-message", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { seq?: unknown; text?: unknown };
    if (
      typeof body.seq !== "number" ||
      !Number.isInteger(body.seq) ||
      body.seq < 0 ||
      typeof body.text !== "string" ||
      !body.text.trim()
    ) {
      return reply.code(400).send({ error: "请求体需包含非负整数字段 seq 与非空字符串字段 text" });
    }
    try {
      const seq = await service.editAndResend(id, body.seq, body.text);
      reply.code(202);
      return { accepted: true, seq };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 切换会话模型：{ providerId, modelId } */
  app.post("/api/sessions/:id/model", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { providerId?: unknown; modelId?: unknown };
    if (typeof body?.providerId !== "string" || typeof body?.modelId !== "string" || !body.modelId) {
      return reply.code(400).send({ error: "请求体需包含字符串字段 providerId 与 modelId" });
    }
    try {
      return { session: await service.setModel(id, { providerId: body.providerId, modelId: body.modelId }) };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 设置思考强度：{ level: off|minimal|low|medium|high|xhigh|max } */
  app.post("/api/sessions/:id/thinking", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { level?: unknown };
    if (typeof body?.level !== "string" || !THINKING_LEVELS.includes(body.level as ThinkingLevel)) {
      return reply.code(400).send({ error: `请求体需包含字段 level，取值 ${THINKING_LEVELS.join("|")}` });
    }
    try {
      return { session: await service.setThinkingLevel(id, body.level as ThinkingLevel) };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 上下文占用与成分分解（占用条/详情弹窗） */
  app.get("/api/sessions/:id/context", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { context: await service.getContext(id) };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 手动压缩上下文：{ instructions? } */
  app.post("/api/sessions/:id/compact", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { instructions?: unknown };
    if (body?.instructions !== undefined && typeof body.instructions !== "string") {
      return reply.code(400).send({ error: "instructions 需为字符串" });
    }
    try {
      await service.compactSession(id, typeof body?.instructions === "string" ? body.instructions : undefined);
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
    reply.code(202);
    return { accepted: true };
  });

  /** 从历史某条用户消息处分支：{ fromSeq } */
  app.post("/api/sessions/:id/branch", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { fromSeq?: unknown };
    if (typeof body?.fromSeq !== "number" || !Number.isInteger(body.fromSeq) || body.fromSeq < 0) {
      return reply.code(400).send({ error: "请求体需包含非负整数字段 fromSeq（须为一条用户消息的 seq）" });
    }
    try {
      const session = await service.branchSession(id, body.fromSeq);
      reply.code(201);
      return { session };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 会话可用的 slash 命令（prompt 模板 + skill 映射） */
  app.get("/api/sessions/:id/commands", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { commands: await service.listCommands(id) };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 会话加载的技能（全局 + 项目级） */
  app.get("/api/sessions/:id/skills", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { skills: await service.listSkills(id) };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 项目文件浏览（@ 引用补全）：?path=<项目根内相对目录> */
  app.get("/api/sessions/:id/files", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: relative } = req.query as { path?: string };
    try {
      return { entries: await service.listProjectFiles(id, relative ?? "") };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 项目共享地图图层清单（注册项目的 .latio/webgis）。 */
  app.get("/api/projects/:id/map/layers", async (req, reply) => {
    if (!mapService) return reply.code(500).send({ error: "地图服务未初始化" });
    const { id } = req.params as { id: string };
    try {
      return { layers: mapService.listLayers(id) };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  app.get("/api/projects/:id/map/layers/:layerId/geojson", async (req, reply) => {
    if (!mapService) return reply.code(500).send({ error: "地图服务未初始化" });
    const { id, layerId } = req.params as { id: string; layerId: string };
    try {
      const geojson = mapService.readLayerGeoJSON(id, layerId);
      if (geojson === null) return reply.code(404).send({ error: `图层不存在或制品缺失: ${layerId}` });
      return reply.header("content-type", "application/geo+json; charset=utf-8").send(geojson);
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 拖拽上传矢量数据并登记为图层（multipart；shp 含 sidecar、gpkg/geojson/kml、gdb 目录） */
  app.post("/api/projects/:id/map/upload", async (req, reply) => {
    if (!mapService) return reply.code(500).send({ error: "地图服务未初始化" });
    const { id } = req.params as { id: string };
    try {
      return await handleUpload(req, reply, mapService.uploadContext(id));
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  app.get("/api/projects/:id/map/config", async (req, reply) => {
    if (!mapService) return reply.code(500).send({ error: "地图服务未初始化" });
    const { id } = req.params as { id: string };
    try {
      return { config: mapService.getConfig(id) };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  app.put("/api/projects/:id/map/config", async (req, reply) => {
    if (!mapService) return reply.code(500).send({ error: "地图服务未初始化" });
    const { id } = req.params as { id: string };
    try {
      return { config: mapService.updateConfig(id, req.body) };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  app.patch("/api/projects/:id/map/layers/:layerId", async (req, reply) => {
    if (!mapService) return reply.code(500).send({ error: "地图服务未初始化" });
    const { id, layerId } = req.params as { id: string; layerId: string };
    const body = (req.body ?? {}) as { alias?: unknown; visible?: unknown; order?: unknown };
    const patch = {
      ...(typeof body.alias === "string" ? { alias: body.alias } : {}),
      ...(typeof body.visible === "boolean" ? { visible: body.visible } : {}),
      ...(typeof body.order === "number" && Number.isFinite(body.order) ? { order: body.order } : {}),
    };
    if (!Object.keys(patch).length) return reply.code(400).send({ error: "至少提供 alias、visible 或 order 之一" });
    try {
      const layer = mapService.updateLayer(id, layerId, patch);
      if (!layer) return reply.code(404).send({ error: `图层不存在: ${layerId}` });
      return { layer };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  app.delete("/api/projects/:id/map/layers/:layerId", async (req, reply) => {
    if (!mapService) return reply.code(500).send({ error: "地图服务未初始化" });
    const { id, layerId } = req.params as { id: string; layerId: string };
    const { purge } = req.query as { purge?: string };
    try {
      const removed = mapService.detachLayer(id, layerId, purge === "1");
      if (!removed) return reply.code(404).send({ error: `图层不存在: ${layerId}` });
      reply.code(202);
      return { accepted: true, purged: purge === "1" };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** GIS 地图图层清单（WebGIS 面板）：会话所属项目的地图制品 */
  app.get("/api/sessions/:id/map/layers", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { layers: await service.listMapLayers(id) };
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 图层 GeoJSON 原文（按图层 id 映射到受控制品路径，越界/缺失 404） */
  app.get("/api/sessions/:id/map/layers/:layerId/geojson", async (req, reply) => {
    const { id, layerId } = req.params as { id: string; layerId: string };
    try {
      const geojson = await service.readMapLayerGeoJSON(id, layerId);
      if (geojson === null) return reply.code(404).send({ error: `图层不存在或制品缺失: ${layerId}` });
      return reply.header("content-type", "application/geo+json; charset=utf-8").send(geojson);
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  /** 拖拽上传矢量数据并登记为图层（multipart；shp 含 sidecar、gpkg/geojson/kml、gdb 目录） */
  app.post("/api/sessions/:id/map/upload", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const context = await service.sessionUploadContext(id);
      return await handleUpload(req, reply, context);
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
  });

  app.post("/api/sessions/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await service.cancel(id);
    } catch (err) {
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
    reply.code(202);
    return { accepted: true };
  });

  /** 回复审批请求：{ request_id, approved } */
  app.post("/api/sessions/:id/approval", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { request_id?: unknown; approved?: unknown };
    if (typeof body?.request_id !== "string" || typeof body?.approved !== "boolean") {
      return reply.code(400).send({ error: "请求体需包含字符串字段 request_id 与布尔字段 approved" });
    }
    try {
      await service.approve(id, body.request_id, body.approved);
    } catch (err) {
      // 审批请求不存在/已处理/已超时
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
    reply.code(202);
    return { accepted: true };
  });

  /** 回传用户对 ask_user 提问的作答：{ request_id, answers } 或 { request_id, cancelled: true } */
  app.post("/api/sessions/:id/question", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      request_id?: unknown;
      answers?: unknown;
      cancelled?: unknown;
    };
    if (typeof body?.request_id !== "string") {
      return reply.code(400).send({ error: "请求体需包含字符串字段 request_id" });
    }
    const cancelled = body.cancelled === true;
    const answers = body.answers && typeof body.answers === "object"
      ? (body.answers as Record<string, { selected: string[]; custom?: string }>)
      : undefined;
    if (!cancelled && !answers) {
      return reply.code(400).send({ error: "需提供 answers（作答）或 cancelled=true（取消提问）" });
    }
    try {
      await service.answerQuestion(id, body.request_id, cancelled ? { cancelled: true } : { answers });
    } catch (err) {
      // 提问请求不存在/已处理/已超时
      return reply.code(errorStatus(err)).send({ error: (err as Error).message });
    }
    reply.code(202);
    return { accepted: true };
  });

  /**
   * SSE：实时推送内部 AgentEvent。
   * 每条事件为一帧 `data: <JSON>\n\n`，25s 心跳防中间层超时。
   */
  app.get("/api/sessions/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await service.getSession(id))) {
      return reply.code(404).send({ error: `会话不存在: ${id}` });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    raw.write("retry: 3000\n\n");

    const unsubscribe = service.subscribeEvents(id, (event) => {
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => raw.write(": ping\n\n"), 25000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
