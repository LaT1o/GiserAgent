/**
 * 统一内部 Agent Event 数据结构。
 *
 * 所有 Agent Runtime（当前为 Pi，未来可能为 OpenCode/Codex）的事件
 * 都必须由各自 Adapter 转换成本文件定义的事件后，才能进入
 * Application API 和前端。上层不允许感知具体 Runtime 的事件格式。
 *
 * 字段命名沿用设计文档的 snake_case 约定（session_id / call_id）。
 */

import type { AgentSessionInfo } from "./session.js";

export type AgentEventType =
  | "session.started"
  /** 会话元数据变更（标题/模式/权限），携带最新快照 */
  | "session.updated"
  /** 用户发出的消息（落盘回放用；live 流前端已本地渲染，需按内容去重） */
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
  /** 工具执行前的人工确认请求（approval 扩展产生） */
  | "approval.required"
  /** 审批结果（批准/拒绝/超时），落盘供回放恢复审批卡片终态 */
  | "approval.resolved"
  /** Agent 向用户发起的结构化提问（ask_user 工具产生） */
  | "question.required"
  /** 提问终态（作答/取消/超时），落盘供回放恢复问卷卡片终态 */
  | "question.answered"
  | "agent.error"
  | "turn.completed"
  /** 上下文压缩开始（手动或自动阈值触发） */
  | "session.compacting"
  /** 上下文压缩结束（落盘供回放显示"已压缩"系统行） */
  | "session.compacted"
  /** 一轮模型响应的 token 账单（占用条实时更新；落盘供回放恢复占用） */
  | "turn.usage"
  | "session.completed";

interface AgentEventCommon {
  type: AgentEventType;
  session_id: string;
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 会话内单调递增序号（事件落盘与前端回放去重用） */
  seq?: number;
}

export interface SessionStartedEvent extends AgentEventCommon {
  type: "session.started";
}

export interface SessionUpdatedEvent extends AgentEventCommon {
  type: "session.updated";
  session: AgentSessionInfo;
}

/** 用户消息附带的图片（base64，与发给模型的内容一致；落盘供回放渲染） */
export interface UserMessageImage {
  mimeType: string;
  data: string;
}

/** 用户消息（sendMessage 时落盘，历史回放重建时间线用） */
export interface UserMessageEvent extends AgentEventCommon {
  type: "user.message";
  text: string;
  /** 图片附件（已压缩，仅多模态模型可用的输入通道） */
  images?: UserMessageImage[];
}

export interface TurnStartedEvent extends AgentEventCommon {
  type: "turn.started";
}

/** 流式输出的思考增量（模型 reasoning 通道，可能不存在） */
export interface AssistantThinkingDeltaEvent extends AgentEventCommon {
  type: "assistant.thinking_delta";
  delta: string;
}

/** 流式输出的文本增量 */
export interface AssistantDeltaEvent extends AgentEventCommon {
  type: "assistant.delta";
  delta: string;
}

/** 一条完整的思考内容（message_end 时聚合下发，回放时替代 delta 重建思考块） */
export interface AssistantThinkingEvent extends AgentEventCommon {
  type: "assistant.thinking";
  text: string;
}

/** 一条完整的 assistant 消息（含本轮全部文本） */
export interface AssistantMessageEvent extends AgentEventCommon {
  type: "assistant.message";
  text: string;
}

export interface ToolStartedEvent extends AgentEventCommon {
  type: "tool.started";
  tool: string;
  call_id: string;
}

export interface ToolInputEvent extends AgentEventCommon {
  type: "tool.input";
  tool: string;
  call_id: string;
  /** 工具入参（通常是 JSON 对象） */
  input: unknown;
}

export interface ToolOutputEvent extends AgentEventCommon {
  type: "tool.output";
  tool: string;
  call_id: string;
  /** 工具输出摘要文本 */
  output: string;
}

export interface ToolCompletedEvent extends AgentEventCommon {
  type: "tool.completed";
  tool: string;
  call_id: string;
  success: boolean;
}

/** 工具执行前的人工确认请求；批准/拒绝结果经 AgentAdapter.approve 回传 */
export interface ApprovalRequiredEvent extends AgentEventCommon {
  type: "approval.required";
  /** 审批请求 id，approve 时原样传回 */
  request_id: string;
  tool: string;
  call_id: string;
  input: unknown;
  /** 供前端直接展示的操作摘要（命令 / 代码首行 / 文件路径等） */
  summary: string;
}

/** 审批请求的处理结果（批准 / 拒绝 / 超时自动拒绝） */
export interface ApprovalResolvedEvent extends AgentEventCommon {
  type: "approval.resolved";
  /** 对应 approval.required 的 request_id */
  request_id: string;
  approved: boolean;
}

/** Agent 向用户发起的结构化提问（ask_user 工具产生）；用户作答经 AgentAdapter.answerQuestion 回传 */
export interface QuestionRequiredEvent extends AgentEventCommon {
  type: "question.required";
  /** 提问请求 id，answerQuestion 时原样传回 */
  request_id: string;
  /** 问题清单（题 id / 题干 / 选项 / 单选多选 / 是否允许其他） */
  questions: Array<{
    id: string;
    prompt: string;
    options: Array<{ label: string; description?: string }>;
    multiple?: boolean;
    allowOther?: boolean;
  }>;
}

/** 提问的终态（用户作答 / 主动取消 / 等待超时），落盘供回放恢复问卷卡片终态 */
export interface QuestionAnsweredEvent extends AgentEventCommon {
  type: "question.answered";
  /** 对应 question.required 的 request_id */
  request_id: string;
  /** 用户作答（按题 id 索引；取消/超时时为空） */
  answers?: Record<string, { selected: string[]; custom?: string }>;
  cancelled?: boolean;
  timeout?: boolean;
}

export interface AgentErrorEvent extends AgentEventCommon {
  type: "agent.error";
  error: string;
}

export interface TurnCompletedEvent extends AgentEventCommon {
  type: "turn.completed";
}

/** 上下文压缩开始（SDK compaction_start 转换而来） */
export interface SessionCompactingEvent extends AgentEventCommon {
  type: "session.compacting";
  /** manual=手动触发 / threshold=自动阈值 / overflow=超出上下文 */
  reason: string;
}

/** 上下文压缩结束（SDK compaction_end 转换而来） */
export interface SessionCompactedEvent extends AgentEventCommon {
  type: "session.compacted";
  reason: string;
  tokensBefore?: number;
  tokensAfter?: number;
  aborted?: boolean;
  errorMessage?: string;
}

/** 本轮 Agent 运行结束（对应一次 prompt 的完整生命周期收尾） */
export interface SessionCompletedEvent extends AgentEventCommon {
  type: "session.completed";
}

/** 一轮模型响应的 token 账单（SDK message_end 的 usage 转换而来） */
export interface TurnUsageEvent extends AgentEventCommon {
  type: "turn.usage";
  /** 本轮 token 账单（真实值） */
  usage: {
    /** 本轮请求的输入 token（≈当前上下文占用） */
    input: number;
    /** 本轮生成的输出 token */
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    /** 思考 token（output 的子集；上游不报告时缺省） */
    reasoning?: number;
    totalTokens: number;
  };
}

export type AgentEvent =
  | SessionStartedEvent
  | SessionUpdatedEvent
  | UserMessageEvent
  | TurnStartedEvent
  | AssistantThinkingDeltaEvent
  | AssistantDeltaEvent
  | AssistantThinkingEvent
  | AssistantMessageEvent
  | ToolStartedEvent
  | ToolInputEvent
  | ToolOutputEvent
  | ToolCompletedEvent
  | ApprovalRequiredEvent
  | ApprovalResolvedEvent
  | QuestionRequiredEvent
  | QuestionAnsweredEvent
  | AgentErrorEvent
  | TurnCompletedEvent
  | SessionCompactingEvent
  | SessionCompactedEvent
  | TurnUsageEvent
  | SessionCompletedEvent;

/** 构造内部事件的便捷函数，自动补充 session_id 与 timestamp */
export function makeEvent<T extends AgentEvent>(
  sessionId: string,
  build: () => Omit<T, "session_id" | "timestamp">
): T {
  return {
    ...build(),
    session_id: sessionId,
    timestamp: new Date().toISOString(),
  } as T;
}
