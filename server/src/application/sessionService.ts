/**
 * Session 业务层。
 *
 * API 层只与本模块交互；本模块只依赖 AgentAdapter 接口，
 * 不感知任何具体 Agent Runtime（Pi 等）。
 * 具体实现由入口 index.ts 注入（composition root 模式）。
 */

import type {
  AgentAdapter,
  AgentHistoryRecord,
  AvailableModel,
  CreateSessionInput,
  GlobalSkillInfo,
  ImportModelInput,
  ListSessionsOptions,
  ProjectFileEntry,
  ProviderSummary,
  SessionCommand,
  SessionContextInfo,
  SessionSkill,
} from "../agent/adapter.js";
import type { AgentEvent, UserMessageImage } from "../agent/events.js";
import type {
  AgentSessionInfo,
  AgentSessionMode,
  ModelRef,
  SessionPermissions,
  ThinkingLevel,
} from "../agent/session.js";
import type { ProjectStore } from "../projects.js";
import type { MapLayer } from "../webgis.js";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export class SessionService {
  /** 默认临时项目路径（未指定项目时新建会话的归属，workspace/temp） */
  readonly defaultProjectPath: string;

  constructor(
    private adapter: AgentAdapter,
    /** 项目实体（projectId → path 解析与 lastUsedAt 维护；缺省不启用项目绑定） */
    private projects?: ProjectStore,
    workspaceDir?: string
  ) {
    this.defaultProjectPath = resolve(workspaceDir ?? "", "temp");
  }

  async createSession(input?: CreateSessionInput): Promise<AgentSessionInfo> {
    // projectId 优先：解析为项目路径并刷新最近使用时间；projectPath 直传仍兼容。
    // 两者皆未指定时归入默认临时项目（workspace/temp），避免会话散落隔离工作区
    let effective = input;
    if (input?.projectId) {
      const project = this.projects?.get(input.projectId);
      if (!project) throw new Error(`项目不存在: ${input.projectId}`);
      this.projects!.touchByPath(project.path);
      effective = { projectPath: project.path };
    } else if (input?.projectPath) {
      this.projects?.touchByPath(input.projectPath);
    } else if (this.defaultProjectPath) {
      mkdirSync(this.defaultProjectPath, { recursive: true });
      this.projects?.touchByPath(this.defaultProjectPath);
      effective = { projectPath: this.defaultProjectPath };
    }
    // 上面重建 effective 会丢掉 draft，需显式保留（临时会话标记）
    if (input?.draft) effective = { ...(effective ?? {}), draft: true };
    return this.adapter.createSession(effective);
  }

  listSessions(options?: ListSessionsOptions): Promise<AgentSessionInfo[]> {
    return this.adapter.listSessions(options);
  }

  async getSession(id: string): Promise<AgentSessionInfo | null> {
    return this.adapter.getSession(id);
  }

  async renameSession(id: string, title: string): Promise<AgentSessionInfo> {
    await this.requireActiveSession(id);
    return this.adapter.renameSession(id, title);
  }

  async toggleSessionPin(id: string, pinned: boolean): Promise<AgentSessionInfo> {
    await this.requireActiveSession(id);
    return this.adapter.toggleSessionPin(id, pinned);
  }

  reorderSessions(orderedIds: string[]): Promise<void> {
    return this.adapter.setSessionOrder(orderedIds);
  }

  async deleteSession(id: string): Promise<void> {
    await this.requireActiveSession(id);
    await this.adapter.deleteSession(id);
  }

  async restoreSession(id: string): Promise<AgentSessionInfo> {
    if (!(await this.findInAll(id))) {
      throw new SessionNotFoundError(id);
    }
    return this.adapter.restoreSession(id);
  }

  async purgeSession(id: string): Promise<void> {
    if (!(await this.findInAll(id))) {
      throw new SessionNotFoundError(id);
    }
    await this.adapter.purgeSession(id);
  }

  async setMode(id: string, mode: AgentSessionMode): Promise<AgentSessionInfo> {
    await this.requireActiveSession(id);
    return this.adapter.setMode(id, mode);
  }

  async setPermissions(id: string, permissions: SessionPermissions): Promise<AgentSessionInfo> {
    await this.requireActiveSession(id);
    return this.adapter.setPermissions(id, permissions);
  }

  async sendMessage(id: string, text: string, images?: UserMessageImage[]): Promise<number> {
    if (!(await this.adapter.getSession(id))) {
      throw new SessionNotFoundError(id);
    }
    return this.adapter.sendMessage(id, text, images);
  }

  /** 编辑历史用户消息并原地重发（其后轨迹被替换） */
  async editAndResend(id: string, fromSeq: number, text: string): Promise<number> {
    if (!(await this.adapter.getSession(id))) {
      throw new SessionNotFoundError(id);
    }
    return this.adapter.editAndResend(id, fromSeq, text);
  }

  listModels(): Promise<AvailableModel[]> {
    return this.adapter.listModels();
  }

  async setModel(id: string, model: ModelRef): Promise<AgentSessionInfo> {
    await this.requireActiveSession(id);
    return this.adapter.setModel(id, model);
  }

  async setThinkingLevel(id: string, level: ThinkingLevel): Promise<AgentSessionInfo> {
    await this.requireActiveSession(id);
    return this.adapter.setThinkingLevel(id, level);
  }

  getContext(id: string): Promise<SessionContextInfo> {
    return this.adapter.getContext(id);
  }

  listProviders(): Promise<ProviderSummary[]> {
    return this.adapter.listProviders();
  }

  addProvider(input: { id: string; name?: string; baseUrl: string; api?: string; apiKey?: string }): Promise<ProviderSummary> {
    return this.adapter.addProvider(input);
  }

  updateProvider(id: string, input: { name?: string; baseUrl?: string; apiKey?: string }): Promise<ProviderSummary> {
    return this.adapter.updateProvider(id, input);
  }

  removeModels(providerId: string, modelIds: string[]): Promise<ProviderSummary> {
    return this.adapter.removeModels(providerId, modelIds);
  }

  resolveDefaultModel(): ModelRef | null {
    return this.adapter.resolveDefaultModel();
  }

  listGlobalSkills(): Promise<GlobalSkillInfo[]> {
    return this.adapter.listGlobalSkills();
  }

  deleteGlobalSkill(path: string): Promise<void> {
    return this.adapter.deleteGlobalSkill(path);
  }

  removeProvider(id: string): Promise<void> {
    return this.adapter.removeProvider(id);
  }

  getStoredApiKey(providerId: string): string | undefined {
    return this.adapter.getStoredApiKey(providerId);
  }

  importModels(providerId: string, models: ImportModelInput[]): Promise<ProviderSummary> {
    return this.adapter.importModels(providerId, models);
  }

  async compactSession(id: string, instructions?: string): Promise<void> {
    await this.requireActiveSession(id);
    await this.adapter.compactSession(id, instructions);
  }

  async branchSession(id: string, fromSeq: number): Promise<AgentSessionInfo> {
    await this.requireActiveSession(id);
    return this.adapter.branchSession(id, fromSeq);
  }

  async listCommands(id: string): Promise<SessionCommand[]> {
    await this.requireActiveSession(id);
    return this.adapter.listCommands(id);
  }

  async listSkills(id: string): Promise<SessionSkill[]> {
    await this.requireActiveSession(id);
    return this.adapter.listSkills(id);
  }

  async listProjectFiles(id: string, relativeDir: string): Promise<ProjectFileEntry[]> {
    await this.requireActiveSession(id);
    return this.adapter.listProjectFiles(id, relativeDir);
  }

  /** 地图图层清单（GIS 工具产出的 GeoJSON 制品） */
  async listMapLayers(id: string): Promise<MapLayer[]> {
    await this.requireActiveSession(id);
    return this.adapter.listMapLayers(id);
  }

  /** 图层 GeoJSON 原文（缺失返回 null，由路由层转 404） */
  async readMapLayerGeoJSON(id: string, layerId: string): Promise<string | null> {
    await this.requireActiveSession(id);
    return this.adapter.readMapLayerGeoJSON(id, layerId);
  }

  /** 会话的矢量上传上下文（拖拽上图）：webgis 目录、便携 Python、读取基准目录 */
  async sessionUploadContext(id: string): Promise<{
    webgisDir: string;
    pythonExecutable: string;
    cwd: string;
    sessionId: string;
  }> {
    await this.requireActiveSession(id);
    return this.adapter.sessionUploadContext(id);
  }

  async cancel(id: string): Promise<void> {
    if (!(await this.adapter.getSession(id))) {
      throw new SessionNotFoundError(id);
    }
    await this.adapter.cancel(id);
  }

  /** 回复审批请求（approval.required 的 request_id） */
  async approve(id: string, requestId: string, approved: boolean): Promise<void> {
    if (!(await this.adapter.getSession(id))) {
      throw new SessionNotFoundError(id);
    }
    await this.adapter.approve(id, requestId, approved);
  }

  /** 回传用户对 ask_user 提问的作答（question.required 的 request_id） */
  async answerQuestion(
    id: string,
    requestId: string,
    payload: { answers?: Record<string, { selected: string[]; custom?: string }>; cancelled?: boolean }
  ): Promise<void> {
    if (!(await this.adapter.getSession(id))) {
      throw new SessionNotFoundError(id);
    }
    await this.adapter.answerQuestion(id, requestId, payload);
  }

  subscribeEvents(id: string, cb: (event: AgentEvent) => void): () => void {
    try {
      return this.adapter.subscribeEvents(id, cb);
    } catch {
      // 订阅不存在的会话：返回空取消函数，由调用方先行校验存在性
      return () => {};
    }
  }

  history(id: string, afterSeq?: number): Promise<AgentHistoryRecord[]> {
    return this.adapter.history(id, afterSeq);
  }

  async dispose(): Promise<void> {
    await this.adapter.dispose();
  }

  /** 校验会话存在且不在回收站 */
  private async requireActiveSession(id: string): Promise<void> {
    if (!(await this.adapter.getSession(id))) {
      throw new SessionNotFoundError(id);
    }
  }

  /** 在全部会话（含回收站）中查找 */
  private async findInAll(id: string): Promise<AgentSessionInfo | null> {
    const all = await this.adapter.listSessions({ includeDeleted: true });
    return all.find((s) => s.id === id) ?? null;
  }
}

export class SessionNotFoundError extends Error {
  constructor(public sessionId: string) {
    super(`会话不存在: ${sessionId}`);
  }
}
