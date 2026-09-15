/**
 * AgentAdapter：产品与 Agent Runtime 之间的最小稳定接口。
 *
 * Application 层和 API 层只允许 import 本文件与 events.ts / session.ts，
 * 不允许出现任何具体 Runtime（Pi/OpenCode/Codex）的类型或模块引用。
 *
 * Phase 0 只有 PiAdapter 一个实现（agent/pi/piAdapter.ts），
 * 由入口 index.ts 作为组装点选择实现并注入。
 */

import type { AgentEvent, UserMessageImage } from "./events.js";
import type {
  AgentSessionInfo,
  AgentSessionMode,
  ModelRef,
  SessionPermissions,
  ThinkingLevel,
} from "./session.js";
import type { MapLayer } from "../webgis.js";

/** 事件落盘记录（events.jsonl 每行结构），用于历史回放 */
export interface AgentHistoryRecord {
  seq: number;
  event: AgentEvent;
}

/** 可用模型描述（models.json 解析结果） */
export interface AvailableModel {
  providerId: string;
  modelId: string;
  name: string;
  /** 输入模态：text / image（多模态模型含 image） */
  input: string[];
  contextWindow: number;
  maxTokens: number;
  /** 推理模型标记（false 时思考滑块不可用） */
  reasoning: boolean;
  /** 该模型实际可用的思考档位（reasoning=false 时为 ["off"]） */
  thinkingLevels: ThinkingLevel[];
  /** 思考档位 → 上游原生档位名映射（xhigh/max 靠它显式解锁） */
  thinkingLevelMap?: Record<string, string | null>;
}

/** 模型提供商摘要（不含密钥） */
export interface ProviderSummary {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  modelCount: number;
  /** auth.json 中存有密钥 */
  hasStoredKey: boolean;
}

/** 导入模型的入参（models.json 模型条目） */
export interface ImportModelInput {
  id: string;
  name?: string;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  /** 思考档位 → 上游原生档位名映射；传空对象清除扩展档位（xhigh/max） */
  thinkingLevelMap?: Record<string, string | null>;
}

/** 会话上下文占用与成分（breakdown 均为本地估算值） */
export interface SessionContextInfo {
  /** 真实总量（来自最近一次 LLM 响应 usage；压缩后到下一轮响应前 tokens 为 null） */
  total: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  /** 成分分解（估算；合计与真实值存在偏差，中文偏高）。分类参考 DeepSeek Harness 的组装理念 */
  breakdown: {
    /** 对话消息（用户 + 助手 + 工具结果） */
    messages: number;
    /** 系统工具（工具定义 schema） */
    tools: number;
    /** 系统提示词（不含技能段） */
    systemPrompt: number;
    /** 技能（系统提示中的 <available_skills> 段） */
    skills: number;
    /** 其他（图片等） */
    other: number;
  };
  /** 最近一轮 LLM 账单（LLM 上报；cost 依赖 models.json 配价，未配为 0） */
  lastUsage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning?: number;
    totalTokens: number;
    cost: { input: number; output: number; total: number };
  };
}

/** 会话可用的 slash 命令（prompt 模板 / skill 映射） */
export interface SessionCommand {
  /** 命令名（含 / 前缀，如 "/review"、"/skill:project-report"） */
  name: string;
  description?: string;
  /** 来源：prompt=prompt 模板文件，skill=技能自动映射 */
  source: "prompt" | "skill";
}

/** 会话可用的技能（loader.getSkills 结果） */
export interface SessionSkill {
  name: string;
  description: string;
  /** SKILL.md 绝对路径 */
  path: string;
  /** user=全局目录（server/.pi/skills），project=会话项目内 */
  scope: "user" | "project";
  /** true 时不出现在系统提示中，只能经 /skill:name 手动触发 */
  disableModelInvocation: boolean;
}

/** 全局技能条目（设置页 Skills 管理用） */
export interface GlobalSkillInfo {
  name: string;
  description: string;
  /** 技能目录绝对路径 */
  path: string;
  /** app=server/.pi/skills，user=~/.agents/skills */
  scope: "app" | "user";
  /** false = 已在应用设置中禁用（会话不加载） */
  enabled: boolean;
}

/** 项目目录浏览条目（@ 文件引用补全用） */
export interface ProjectFileEntry {
  name: string;
  /** 相对于项目根的路径（目录以 / 结尾） */
  relativePath: string;
  directory: boolean;
}

export interface CreateSessionInput {
  /** 绑定的项目目录（绝对路径，须存在）；缺省使用会话隔离工作区 */
  projectPath?: string;
  /** 绑定已注册项目（service 层解析为 projectPath；与 projectPath 二选一，优先） */
  projectId?: string;
  /** 临时会话：不进会话列表，发送首条用户消息时自动转为正式会话 */
  draft?: boolean;
}

export interface ListSessionsOptions {
  /** 包含回收站（软删除）会话 */
  includeDeleted?: boolean;
}

export interface AgentAdapter {
  /** 创建新会话（当前实现：每个会话一个进程内 AgentSession） */
  createSession(input?: CreateSessionInput): Promise<AgentSessionInfo>;
  /** 获取未删除会话；不存在或在回收站中返回 null */
  getSession(id: string): Promise<AgentSessionInfo | null>;
  listSessions(options?: ListSessionsOptions): Promise<AgentSessionInfo[]>;

  /** 重命名会话（写 meta.json 并广播 session.updated） */
  renameSession(id: string, title: string): Promise<AgentSessionInfo>;
  /** 置顶/取消置顶（置顶把 sortOrder 提到最前，取消挪到末尾） */
  toggleSessionPin(id: string, pinned: boolean): Promise<AgentSessionInfo>;
  /** 手动排序：按入参数组位次重写 sortOrder（拖动排序持久化） */
  setSessionOrder(orderedIds: string[]): Promise<void>;
  /** 软删除：停止运行并移入回收站，会话目录与历史保留 */
  deleteSession(id: string): Promise<void>;
  /** 从回收站恢复会话 */
  restoreSession(id: string): Promise<AgentSessionInfo>;
  /** 彻底删除：移除整个会话目录（不可恢复） */
  purgeSession(id: string): Promise<void>;

  /** 切换 plan/act 模式（动态调整工具集，下一轮生效） */
  setMode(id: string, mode: AgentSessionMode): Promise<AgentSessionInfo>;
  /** 更新会话权限（范围拦截立即生效，工具集增删下一轮生效） */
  setPermissions(id: string, permissions: SessionPermissions): Promise<AgentSessionInfo>;

  /**
   * 发送用户消息。立即返回，Agent 的回复和工具执行
   * 全部通过 subscribeEvents 的事件流异步推送。
   * images 为可选图片附件（base64，仅多模态模型支持）。
   * text 以 "/" 开头时按 slash 命令展开（prompt 模板 / skill）。
   * 返回本次 user.message 事件的 seq（前端用于给本地乐观渲染的消息补齐定位）。
   */
  sendMessage(id: string, text: string, images?: UserMessageImage[]): Promise<number>;

  /**
   * 编辑历史用户消息并原地重发：回退到该消息之前，其后的事件轨迹被替换，
   * 再以新文本重新发送（返回新 user.message 的 seq）。运行中的会话拒绝执行。
   */
  editAndResend(id: string, fromSeq: number, text: string): Promise<number>;

  /** 列出 models.json 中全部可用模型（含输入模态/推理标记与可用思考档位） */
  listModels(): Promise<AvailableModel[]>;

  /** 切换会话模型（会话级，重启恢复保持；广播 session.updated） */
  setModel(id: string, model: ModelRef): Promise<AgentSessionInfo>;

  /** 设置会话思考强度（Runtime 按模型能力自动钳制；广播 session.updated） */
  setThinkingLevel(id: string, level: ThinkingLevel): Promise<AgentSessionInfo>;

  /** 查询会话上下文占用与成分分解（占用条/详情弹窗数据源） */
  getContext(id: string): Promise<SessionContextInfo>;

  /** 列出已注册的模型提供商（不含密钥） */
  listProviders(): Promise<ProviderSummary[]>;

  /**
   * 添加提供商：内存注册（已激活会话立即可见）+ models.json 落盘
   * + 真实密钥写 auth.json（重启后恢复）。apiKey 可空（探测后补填场景）。
   */
  addProvider(input: { id: string; name?: string; baseUrl: string; api?: string; apiKey?: string }): Promise<ProviderSummary>;

  /** 删除提供商（仅「正在运行且使用中」的会话阻止；其余引用会话自动切回剩余默认模型） */
  removeProvider(id: string): Promise<void>;

  /** 读取 auth.json 中已保存的提供商密钥（仅用于上游探测等服务端内部用途，不外发） */
  getStoredApiKey(providerId: string): string | undefined;

  /** 编辑提供商（名称/BaseURL/密钥；密钥仅在填写时覆盖 auth.json） */
  updateProvider(id: string, input: { name?: string; baseUrl?: string; apiKey?: string }): Promise<ProviderSummary>;

  /** 删除提供商下指定模型（models.json 移除并重注册运行时） */
  removeModels(providerId: string, modelIds: string[]): Promise<ProviderSummary>;

  /** 向提供商导入模型条目（写 models.json 并刷新内存注册；按 id 合并去重） */
  importModels(providerId: string, models: ImportModelInput[]): Promise<ProviderSummary>;

  /** 解析当前默认模型（用户设置优先，否则首提供商首模型） */
  resolveDefaultModel(): ModelRef | null;

  /** 手动压缩会话上下文（instructions 为给摘要模型的定制指令） */
  compactSession(id: string, instructions?: string): Promise<void>;

  /**
   * 从历史某条用户消息处分支：保留该轮及之前全部内容，
   * 复制为可独立继续对话的新会话（记录 parentSessionId）。
   */
  branchSession(id: string, fromSeq: number): Promise<AgentSessionInfo>;

  /** 列出会话可用的 slash 命令（prompt 模板 + skill 映射） */
  listCommands(id: string): Promise<SessionCommand[]>;

  /** 列出会话加载的技能（全局 + 项目级） */
  listSkills(id: string): Promise<SessionSkill[]>;

  /** 全局技能目录扫描（server/.pi/skills 与 ~/.agents/skills，供设置页管理） */
  listGlobalSkills(): Promise<GlobalSkillInfo[]>;

  /** 删除全局技能目录（仅限两个根之内） */
  deleteGlobalSkill(path: string): Promise<void>;

  /** 浏览项目根下目录（@ 文件引用补全；仅项目根内，防越界） */
  listProjectFiles(id: string, relativeDir: string): Promise<ProjectFileEntry[]>;

  /** 列出会话所属项目的地图图层（GIS 工具产出的 GeoJSON 制品；WebGIS 面板数据源） */
  listMapLayers(id: string): Promise<MapLayer[]>;

  /** 读取图层 GeoJSON 原文（越界/缺失返回 null） */
  readMapLayerGeoJSON(id: string, layerId: string): Promise<string | null>;

  /** 回传用户对 ask_user 提问的作答（answers=按题 id 索引；cancelled=用户取消） */
  answerQuestion(
    id: string,
    requestId: string,
    payload: { answers?: Record<string, { selected: string[]; custom?: string }>; cancelled?: boolean }
  ): Promise<void>;

  /** 会话的矢量上传上下文（拖拽上图）：webgis 目录、便携 Python、读取基准目录 */
  sessionUploadContext(id: string): {
    webgisDir: string;
    pythonExecutable: string;
    cwd: string;
    sessionId: string;
  };

  /** 取消当前正在执行的一轮运行 */
  cancel(id: string): Promise<void>;

  /**
   * 回复一条审批请求（approval.required 事件携带 request_id）。
   * approved=false 时对应工具调用被阻止，原因会回传给 Agent。
   */
  approve(id: string, requestId: string, approved: boolean): Promise<void>;

  /**
   * 订阅某会话的内部事件流，返回取消订阅函数。
   * 回调异常会被捕获并忽略，不影响其他订阅者。
   */
  subscribeEvents(
    id: string,
    cb: (event: AgentEvent) => void
  ): () => void;

  /** 读取事件历史（events.jsonl），返回 seq 大于 afterSeq 的记录 */
  history(id: string, afterSeq?: number): Promise<AgentHistoryRecord[]>;

  /** 关闭所有会话（服务退出时调用） */
  dispose(): Promise<void>;
}
