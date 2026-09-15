/**
 * 会话元数据类型（AgentSessionInfo / 权限 / 模式）。
 *
 * 独立成文件供 adapter.ts 与 events.ts 共同引用，避免循环依赖。
 * 这些字段与会话 meta.json 的落盘结构保持一致。
 */

export type AgentSessionStatus =
  | "starting" /** 子进程启动中 */
  | "idle" /** 空闲，可接收消息 */
  | "running" /** 正在处理一条消息 */
  | "closed"; /** 会话已关闭（子进程退出） */

/** plan/act 模式：plan=只读调研出计划，act=正常执行 */
export type AgentSessionMode = "plan" | "act";

/** 命令行审批策略：ask=每次询问 / smart=只读命令自动放行 / full=跳过审批 */
export type ApprovalMode = "ask" | "smart" | "full";

/**
 * 会话权限（不再由界面抽屉控制）。
 *
 * - read/write/bash/web/mcp 恒为默认值：读取与写入限定会话绑定的项目/工作区
 *   （黑名单仍生效），命令行与执行类工具始终可用；Plan 模式的只读限制由 mode 驱动。
 * - approval：唯一可变项，由状态条的 Plan/Act/YOLO 三档驱动（act=smart、yolo=full）；
 *   ask 为历史默认值，仅用于兼容旧会话数据，读取时归一为 smart。
 */
export interface SessionPermissions {
  read: "off" | "project" | "all";
  write: "off" | "project" | "all";
  bash: boolean;
  approval: ApprovalMode;
  web: boolean;
  mcp: boolean;
}

export const DEFAULT_SESSION_PERMISSIONS: SessionPermissions = {
  read: "project",
  write: "project",
  bash: true,
  approval: "smart",
  web: false,
  mcp: false,
};

/**
 * 权限归一（权限抽屉移除后）：读写范围与执行开关恒为默认值，
 * 仅保留审批档位（YOLO 的 full 持久化；ask/缺省一律归一为 smart）。
 * 旧会话数据里被关掉的读/写/命令行不再生效，避免没有界面可恢复的“死状态”。
 */
export function normalizeSessionPermissions(
  permissions?: Partial<SessionPermissions> | null
): SessionPermissions {
  return {
    ...DEFAULT_SESSION_PERMISSIONS,
    approval: permissions?.approval === "full" ? "full" : "smart",
  };
}

/** 会话当前使用的模型引用（models.json 中的 provider + model id） */
export interface ModelRef {
  providerId: string;
  modelId: string;
}

/**
 * 思考强度档位（与 Pi 的档位值域一致；接口层自定义避免依赖 Runtime 类型）。
 * off=不思考；xhigh/max 仅对 models.json 中 thinkingLevelMap 显式映射的模型开放。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentSessionInfo {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: AgentSessionStatus;
  /** 会话标题（默认取首条用户消息前缀，可重命名） */
  title?: string;
  /** 绑定的项目目录（绝对路径；未绑定为空，cwd 即会话 working 目录） */
  projectPath?: string;
  /** Agent 实际工作目录 */
  cwd: string;
  mode: AgentSessionMode;
  permissions: SessionPermissions;
  /** 会话当前模型（缺省用应用默认模型） */
  model?: ModelRef;
  /** 会话思考强度（缺省 medium；切换模型时由 Runtime 自动钳制到模型能力） */
  thinkingLevel?: ThinkingLevel;
  /** 分支来源会话 id（"从此分支"创建的会话记录其父会话） */
  parentSessionId?: string;
  /** 软删除时间（回收站中的会话） */
  deletedAt?: string;
  /** 手动排序序号（拖动排序持久化；缺省按创建序排在末尾） */
  sortOrder?: number;
  /** 置顶标记（置顶动作把 sortOrder 提到最前，本字段用于图标显示） */
  pinned?: boolean;
  /** 会话目录绝对路径（workspace/sessions/<id>，资源管理器打开用） */
  dir: string;
  /** 临时会话标记（未发送过消息；前端列表隐藏，首条消息后清除） */
  draft?: boolean;
}
