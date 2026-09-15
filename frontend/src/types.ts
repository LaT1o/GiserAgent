/**
 * 与 server 内部事件模型（server/src/agent/events.ts）对应的前端类型。
 * 前端只认识这套统一事件，不感知 Pi 的任何事件格式。
 */

export type SessionStatus = "starting" | "idle" | "running" | "closed";

/** plan=只读调研出计划，act=正常执行 */
export type SessionMode = "plan" | "act";

/** 命令行审批策略（与服务端 session.ts 一致） */
export type ApprovalMode = "ask" | "smart" | "full";

/** 读写权限（与服务端 session.ts 一致） */
export interface SessionPermissions {
  read: "off" | "project" | "all";
  write: "off" | "project" | "all";
  bash: boolean;
  approval: ApprovalMode;
  web: boolean;
  mcp: boolean;
}

/** 会话当前模型引用（models.json 中的 provider + model id） */
export interface ModelRef {
  providerId: string;
  modelId: string;
}

/** 思考强度档位（与服务端一致；off=不思考） */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SessionInfo {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  title?: string;
  /** 绑定的项目目录（未绑定为空） */
  projectPath?: string;
  /** Agent 实际工作目录 */
  cwd: string;
  mode: SessionMode;
  permissions: SessionPermissions;
  /** 会话当前模型（缺省用应用默认模型） */
  model?: ModelRef;
  /** 会话思考强度（切模型时由服务端按模型能力钳制） */
  thinkingLevel?: ThinkingLevel;
  /** 分支来源会话 id */
  parentSessionId?: string;
  /** 软删除时间（回收站中的会话） */
  deletedAt?: string;
  /** 手动排序序号（拖动排序持久化；缺省按创建序排在末尾） */
  sortOrder?: number;
  /** 置顶标记（图标显示用；置顶动作由服务端把 sortOrder 提到最前） */
  pinned?: boolean;
  /** 会话目录绝对路径（资源管理器打开用） */
  dir: string;
  /** 临时会话标记（未发送过消息；列表隐藏，首条消息后清除） */
  draft?: boolean;
}

/** 可用模型（GET /api/models） */
export interface AvailableModel {
  providerId: string;
  modelId: string;
  name: string;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  /** 推理模型标记（false 时思考滑块不可用） */
  reasoning: boolean;
  /** 该模型实际可用的思考档位 */
  thinkingLevels: ThinkingLevel[];
  /** 思考档位 → 上游原生档位名映射（xhigh/max 靠它显式解锁） */
  thinkingLevelMap?: Record<string, string | null>;
}

/** 模型提供商摘要（GET /api/providers，不含密钥） */
export interface ProviderSummary {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  modelCount: number;
  hasStoredKey: boolean;
}

/** 导入模型的入参 */
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

/** 上游 /models 探测结果（能力字段视网关实现可能缺失，缺省时由内置系列档案兜底） */
export interface UpstreamModel {
  id: string;
  name?: string;
  /** 上游自报上下文窗口（token） */
  contextWindow?: number;
  /** 上游自报是否支持推理 */
  reasoning?: boolean;
  /** 上游自报输入模态（仅识别 image，命中时为 ["text","image"]） */
  input?: string[];
  /** 思考档位映射（内置系列档案给出，如 DeepSeek 只保留 low/high/max） */
  thinkingLevelMap?: Record<string, string | null>;
}

/** 项目实体（workspace/projects.json） */
export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastUsedAt: string;
}

/** 目录浏览条目（GET /api/fs/dirs） */
export interface DirEntry {
  name: string;
  path: string;
  parent: string | null;
}

/** 会话上下文占用与成分 */
export interface SessionContextInfo {
  total: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
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

/** 会话可用的 slash 命令 */
export interface SessionCommand {
  name: string;
  description?: string;
  source: "prompt" | "skill";
}

/** 会话加载的技能 */
export interface SessionSkill {
  name: string;
  description: string;
  path: string;
  scope: "user" | "project";
  disableModelInvocation: boolean;
}

/** 全局技能条目（设置页 Skills 管理） */
export interface GlobalSkillInfo {
  name: string;
  description: string;
  path: string;
  scope: "app" | "user";
  /** false = 已禁用（会话不加载该技能） */
  enabled: boolean;
}

/** 项目文件浏览条目（@ 引用补全） */
export interface ProjectFileEntry {
  name: string;
  relativePath: string;
  directory: boolean;
}

/** 用户消息附带的图片（base64） */
export interface UserMessageImage {
  mimeType: string;
  data: string;
}

/** 上下文压缩配置（应用设置；按模型上下文窗口百分比表达） */
export interface CompactionSettings {
  enabled: boolean;
  /** 预留窗口百分比：占用超过 contextWindow × (1 - reserve%) 时触发 */
  reservePercent: number;
  /** 压缩时保留最近对话的窗口百分比 */
  keepPercent: number;
}

/** 地图底图设置（workspace/settings.json；天地图密钥由用户在设置页维护） */
export interface MapSettings {
  basemap: "tianditu" | "none";
  tiandituToken?: string;
}

/** 应用设置（workspace/settings.json） */
export interface AppSettings {
  defaultModel?: ModelRef;
  compaction: CompactionSettings;
  /** 全局自定义指令：追加在内置系统提示词之后（角色设定/协作规则/记忆规则） */
  customInstructions?: string;
  /** WebGIS 底图与服务配置 */
  map: MapSettings;
}

export type AgentEventType =
  | "session.started"
  | "session.updated"
  | "user.message"
  | "turn.started"
  | "assistant.thinking_delta"
  | "assistant.delta"
  | "assistant.thinking"
  | "assistant.message"
  | "tool.started"
  | "tool.input"
  | "tool.output"
  | "tool.completed"
  | "approval.required"
  | "approval.resolved"
  | "question.required"
  | "question.answered"
  | "agent.error"
  | "turn.completed"
  | "session.compacting"
  | "session.compacted"
  | "turn.usage"
  | "session.completed";

export interface AgentEvent {
  type: AgentEventType;
  session_id: string;
  timestamp: string;
  /** 会话内单调递增序号（历史回放与 SSE 去重） */
  seq?: number;
  /** thinking_delta / delta */
  delta?: string;
  text?: string;
  /** user.message 专用：图片附件（base64） */
  images?: UserMessageImage[];
  tool?: string;
  call_id?: string;
  input?: unknown;
  output?: string;
  success?: boolean;
  error?: string;
  /** approval.required 专用 */
  request_id?: string;
  summary?: string;
  /** approval.resolved 专用 */
  approved?: boolean;
  /** question.required 专用：ask_user 提问清单 */
  questions?: Array<{
    id: string;
    prompt: string;
    options: Array<{ label: string; description?: string }>;
    multiple?: boolean;
    allowOther?: boolean;
  }>;
  /** question.answered 专用：用户作答（按题 id 索引）/ 取消 / 超时 */
  answers?: Record<string, { selected: string[]; custom?: string }>;
  cancelled?: boolean;
  timeout?: boolean;
  /** session.compacting / session.compacted 专用 */
  reason?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  aborted?: boolean;
  errorMessage?: string;
  /** turn.usage 专用：本轮 token 账单（真实值，占用条数据源） */
  usage?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    totalTokens: number;
  };
  /** session.updated 专用：最新会话快照 */
  session?: SessionInfo;
}

/** 历史回放记录（events.jsonl 每行） */
export interface HistoryRecord {
  seq: number;
  event: AgentEvent;
}

/** 地图图层条目（GET /api/sessions/:id/map/layers；GIS 工具产出的 GeoJSON 制品） */
export interface MapLayerInfo {
  id: string;
  /** 图层标识名（同一项目内唯一） */
  name: string;
  /** 展示名（图层树显示） */
  alias: string;
  /** 产出来源会话 */
  sessionId: string;
  format: "geojson";
  /** 相对 webgis 目录的制品路径（前端不直接使用，仅供排查） */
  relativePath: string;
  /** 数据坐标系（如 "EPSG:4547"；GeoJSON 坐标保持原坐标系） */
  dataCrs?: string;
  /** 要素范围 [minx, miny, maxx, maxy] */
  bounds?: [number, number, number, number];
  featureCount?: number;
  geometryTypes?: string[];
  fields?: Array<{ name: string; dtype: string }>;
  createdAt: string;
  sourceTool?: string;
  /** 内容版本（重新生成时变化，前端据此刷新图层数据） */
  loadKey: string;
  status: "ready";
  /** 项目地图配置中的显示状态（项目级 API 返回时合并） */
  visible?: boolean;
  /** 叠加顺序（越小越靠下） */
  order?: number;
}
