import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  fetchCommands,
  fetchProjectFiles,
} from "../api/client";
import type {
  AvailableModel,
  ModelRef,
  ProjectFileEntry,
  SessionCommand,
  SessionInfo,
  SessionMode,
  ThinkingLevel,
  UserMessageImage,
} from "../types";
import ContextDetail from "./ContextDetail";
import Dropdown from "./Dropdown";
import RowMenu from "./RowMenu";
import { computeExecutedPlans } from "../timeline";

/** 时间线条目：由 App.reduceEvent 从内部事件归并生成 */
export type TimelineItem =
  | {
      kind: "user";
      key: string;
      text: string;
      /** 图片附件（base64，与发给模型的内容一致） */
      images?: UserMessageImage[];
      /** 该消息的事件 seq（"从此分支"入口） */
      seq?: number;
    }
  | { kind: "assistant"; key: string; text: string; streaming: boolean }
  | { kind: "thinking"; key: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      key: string;
      callId: string;
      tool: string;
      status: "running" | "done" | "failed";
      startedAt: number;
      durationMs?: number;
      input?: unknown;
      output?: string;
      /** 工具启动事件的服务端 seq（「计划已执行」按 seq 判定，免疫回放重建的 key 变化） */
      seq?: number;
    }
  | {
      kind: "approval";
      key: string;
      requestId: string;
      tool: string;
      summary: string;
      status: "pending" | "approved" | "denied";
    }
  | {
      kind: "question";
      key: string;
      requestId: string;
      questions: Array<{
        id: string;
        prompt: string;
        options: Array<{ label: string; description?: string }>;
        multiple?: boolean;
        allowOther?: boolean;
      }>;
      status: "pending" | "answered" | "cancelled" | "timeout";
      /** 终态：用户作答（按题 id 索引） */
      answers?: Record<string, { selected: string[]; custom?: string }>;
    }
  | { kind: "error"; key: string; text: string }
  /** 系统行（上下文压缩等非对话事件） */
  | { kind: "system"; key: string; subtype: "compacting" | "compacted"; text: string }
  /** 轮次结束标记（session.completed 追加，不渲染）：折叠「执行过程」的唯一依据 */
  | { kind: "turnEnd"; key: string };

interface Props {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  session: SessionInfo | null;
  items: TimelineItem[];
  busy: boolean;
  input: string;
  setInput: (v: string) => void;
  models: AvailableModel[];
  /** 应用设置中的默认模型（未设置时为空） */
  defaultModel?: ModelRef;
  /** 当前会话最近一轮 token 账单（占用条数据源；null=尚无响应） */
  usage: { input: number; totalTokens: number } | null;
  onSend: (images?: UserMessageImage[]) => void;
  onCancel: () => void;
  /** 执行中排队待发的消息（整条可点 = 打断当前输出并立即发送） */
  queue: { key: string; text: string }[];
  onQueueForce: (key: string) => void;
  onQueueRemove: (key: string) => void;
  onApprove: (requestId: string, approved: boolean) => void;
  /** ask_user 结构化提问作答：answers=按题 id 索引的选择；cancelled=true 表示用户取消提问 */
  onAnswerQuestion: (
    requestId: string,
    payload: { answers?: Record<string, { selected: string[]; custom?: string }>; cancelled?: boolean }
  ) => void;
  /** 模式档位：plan=规划；act=执行（智能批准）；yolo=执行（完全访问，跳过审批） */
  onModeSelect: (target: "plan" | "act" | "yolo") => void;
  onExecutePlan: () => void;
  onRename: (title: string) => void;
  onModelChange: (model: ModelRef) => void;
  onSetDefaultModel: (model: ModelRef) => void;
  onThinkingChange: (level: ThinkingLevel) => void;
  onCompact: () => void;
  onBranch: (fromSeq: number) => void;
  /** 正在编辑的历史用户消息（气泡内联编辑；null=无） */
  editing: { seq: number } | null;
  onEditStart: (seq: number) => void;
  onEditSubmit: (seq: number, text: string) => void;
  onCancelEdit: () => void;
}

/** 思考强度档位（与服务端一致；界面直接展示原始档位名，不做中文转译） */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 思考文本 token 粗估（中英混排折中 ≈0.6 token/字符；仅作量级参考，非精确计量） */
const estimateTokens = (chars: number) => Math.max(1, Math.round(chars * 0.6));

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** braille 转圈动画 */
function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((f) => f + 1), 110);
    return () => clearInterval(timer);
  }, [active]);
  return active ? SPINNER_FRAMES[frame % SPINNER_FRAMES.length] : "";
}

/** 工具行折叠态的一行摘要 */
function summarizeToolInput(tool: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  if ((tool === "bash" || tool === "powershell") && typeof record.command === "string") {
    return record.command.slice(0, 120);
  }
  if (tool === "opengis" || tool === "arcgis" || tool === "python") {
    if (typeof record.code === "string") {
      const first = record.code.split("\n").find((l) => l.trim()) ?? "";
      return first.slice(0, 100) || (tool === "arcgis" ? "(arcpy 代码)" : "(openGIS 代码)");
    }
    if (typeof record.script === "string") return record.script;
  }
  // 地图工作区工具：显示数据路径与图层名（map_inspect 等；历史轨迹可能是旧名 gis_*）
  if (tool.startsWith("map_") || tool.startsWith("gis_")) {
    const parts: string[] = [];
    if (typeof record.path === "string") parts.push(record.path);
    if (typeof record.alias === "string") parts.push(`→ ${record.alias}`);
    else if (typeof record.name === "string") parts.push(`→ ${record.name}`);
    if (record.add_to_map === false) parts.push("(不图层)");
    if (parts.length) return parts.join(" ").slice(0, 120);
  }
  if (typeof record.path === "string") return record.path;
  if (typeof record.pattern === "string") {
    const where = typeof record.path === "string" ? ` ${record.path}` : "";
    return `${tool} "${record.pattern}"${where}`.slice(0, 120);
  }
  if (tool === "todo" && typeof record.action === "string") {
    return `action=${record.action}${typeof record.text === "string" ? ` ${record.text}`.slice(0, 80) : ""}`;
  }
  try {
    return JSON.stringify(input).slice(0, 100);
  } catch {
    return "";
  }
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return "";
  return ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`;
}

/** 工具显示名（原名优先，仅个别工具名需要美化；gis_* 为改名前的历史轨迹） */
const TOOL_LABELS: Record<string, string> = {
  opengis: "openGIS",
  arcgis: "ArcGIS",
  map_inspect: "地图检查",
  gis_inspect: "地图检查",
};
const toolLabel = (tool: string) => TOOL_LABELS[tool] ?? tool;

function ToolItem({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  const [expanded, setExpanded] = useState(false);
  const spinner = useSpinner(item.status === "running");
  const icon =
    item.status === "running" ? spinner : item.status === "done" ? "✓" : "✗";
  const summary = summarizeToolInput(item.tool, item.input);
  const duration = formatDuration(item.durationMs);

  let inputText = "";
  try {
    inputText = item.input === undefined ? "" : JSON.stringify(item.input, null, 2);
  } catch {
    inputText = String(item.input);
  }

  return (
    <div className={`tl-tool tl-tool-${item.status}`}>
      <button className="tl-tool-row" onClick={() => setExpanded((v) => !v)}>
        <span className="tl-tool-icon">{icon}</span>
        <span className="tl-tool-name">{toolLabel(item.tool)}</span>
        <span className="tl-tool-summary">{summary}</span>
        <span className="tl-tool-duration">{duration}</span>
      </button>
      {expanded && (
        <div className="tl-tool-detail">
          {inputText && (
            <pre className="tl-pre tl-pre-input">{inputText}</pre>
          )}
          {item.output && <pre className="tl-pre tl-pre-output">{item.output}</pre>}
          {!inputText && !item.output && <div className="tl-tool-empty">（无输入输出详情）</div>}
        </div>
      )}
    </div>
  );
}

/** 计划卡片：submit_plan 工具事件渲染为结构化计划 + 「按此计划执行」入口 */
function PlanCard({
  item,
  mode,
  busy,
  executed,
  onExecutePlan,
}: {
  item: Extract<TimelineItem, { kind: "tool" }>;
  mode: SessionMode | undefined;
  busy: boolean;
  /** 该计划之后已存在用户消息（即已点过执行），不再展示执行入口 */
  executed: boolean;
  onExecutePlan: () => void;
}) {
  const input = (item.input ?? {}) as { title?: unknown; steps?: unknown };
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined;
  const steps = Array.isArray(input.steps)
    ? input.steps.filter((s): s is string => typeof s === "string" && !!s.trim())
    : [];
  const failed = item.status === "failed";

  return (
    <div className={`tl-plan${failed ? " tl-plan-failed" : ""}`}>
      <div className="tl-plan-title">📋 {title || "执行计划"}</div>
      {!!steps.length && (
        <ol className="tl-plan-steps">
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      {failed ? (
        <div className="tl-plan-note">✗ 计划提交失败{item.output ? `：${item.output.slice(0, 200)}` : ""}</div>
      ) : executed ? (
        <div className="tl-plan-note tl-plan-done">✓ 此计划已执行</div>
      ) : mode === "plan" ? (
        <button className="tl-plan-execute" disabled={busy} onClick={onExecutePlan}>
          ▶ 按此计划执行
        </button>
      ) : (
        <div className="tl-plan-note tl-plan-done">✓ 已进入执行模式</div>
      )}
    </div>
  );
}

/**
 * 「执行过程」折叠组：把该轮的过程条目（思考/工具/审批/中间回复）收拢为一行摘要。
 * 开始时即渲染并默认展开（内容实时可见），本轮结束后自动折叠一次；
 * 执行过程中允许手动开合，用户手动操作过则不再被自动折叠覆盖。最终回答不在此组内。
 */
function ProcessGroup({
  items,
  renderItem,
  running,
}: {
  items: TimelineItem[];
  renderItem: (item: TimelineItem) => React.ReactNode;
  running: boolean;
}) {
  // 进行中的轮次默认展开；历史与已结束的轮次默认折叠
  const [expanded, setExpanded] = useState(running);
  const userToggled = useRef(false);
  useEffect(() => {
    if (!running && !userToggled.current) setExpanded(false);
  }, [running]);
  const toolCount = items.filter((it) => it.kind === "tool").length;
  const thinkingChars = items.reduce((n, it) => (it.kind === "thinking" ? n + it.text.length : n), 0);
  const replyCount = items.filter((it) => it.kind === "assistant").length;
  const meta = [
    toolCount ? `${toolCount} 个工具` : "",
    thinkingChars ? `思考 ≈${estimateTokens(thinkingChars)} tokens` : "",
    replyCount ? `${replyCount} 条中间回复` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="tl-process">
      <button
        type="button"
        className="tl-process-row"
        aria-expanded={expanded}
        onClick={() => {
          userToggled.current = true;
          setExpanded((v) => !v);
        }}
      >
        <span className="tl-process-caret">{expanded ? "▾" : "▸"}</span>
        <span className="tl-process-label">执行过程</span>
        {meta && <span className="tl-process-meta">{meta}</span>}
      </button>
      {expanded && <div className="tl-process-body">{items.map(renderItem)}</div>}
    </div>
  );
}

/** 窗口控制图标：用 SVG 绘制（字体几何符号 □/❐ 的字面大小随字体而异，易偏小/偏位） */
function WinIcon({ name }: { name: "min" | "max" | "restore" | "close" }) {
  const common = { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": true } as const;
  if (name === "min") {
    return (
      <svg {...common}>
        <path d="M1.5 6h9" stroke="currentColor" strokeWidth="1" />
      </svg>
    );
  }
  if (name === "close") {
    return (
      <svg {...common}>
        <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1" />
      </svg>
    );
  }
  if (name === "restore") {
    return (
      <svg {...common}>
        <rect x="1" y="4.5" width="6.5" height="6.5" fill="none" stroke="currentColor" strokeWidth="1" />
        <path d="M4.5 4.5V1H11v6.5H7.5" fill="none" stroke="currentColor" strokeWidth="1" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="1" y="1" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

/** 桌面窗口控制（无边框模式）：preload 注入 window.giserDesktop，浏览器环境不渲染 */
function WinControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const off = window.giserDesktop?.onMaximizeChange(setMaximized);
    return () => off?.();
  }, []);
  if (!window.giserDesktop) return null;
  return (
    <div className="win-controls">
      <button title="最小化" onClick={() => void window.giserDesktop?.minimize()}>
        <WinIcon name="min" />
      </button>
      <button
        title={maximized ? "还原" : "最大化"}
        onClick={() => void window.giserDesktop?.toggleMaximize()}
      >
        <WinIcon name={maximized ? "restore" : "max"} />
      </button>
      <button title="关闭" className="win-close" onClick={() => void window.giserDesktop?.close()}>
        <WinIcon name="close" />
      </button>
    </div>
  );
}

function ThinkingItem({ item }: { item: Extract<TimelineItem, { kind: "thinking" }> }) {
  const [expanded, setExpanded] = useState(false);
  const spinner = useSpinner(item.streaming);
  return (
    <div className="tl-thinking">
      <button className="tl-thinking-row" onClick={() => setExpanded((v) => !v)}>
        <span className="tl-thinking-icon">{item.streaming ? spinner : "◆"}</span>
        <span className="tl-thinking-label">
          {item.streaming ? "思考中…" : `思考过程（≈${estimateTokens(item.text.length)} tokens）`}
        </span>
        <span className="tl-thinking-toggle">{expanded ? "收起" : "展开"}</span>
      </button>
      {expanded && <pre className="tl-pre tl-thinking-text">{item.text}</pre>}
    </div>
  );
}

function ApprovalItem({
  item,
  onApprove,
}: {
  item: Extract<TimelineItem, { kind: "approval" }>;
  onApprove: (requestId: string, approved: boolean) => void;
}) {
  const spinner = useSpinner(item.status === "pending");
  return (
    <div className={`tl-approval tl-approval-${item.status}`}>
      <div className="tl-approval-title">
        {item.status === "pending" ? (
          <>
            <span className="tl-approval-icon">{spinner}</span>需要确认：执行 {item.tool}
          </>
        ) : item.status === "approved" ? (
          <>✓ 已允许：{item.tool}</>
        ) : (
          <>✗ 已拒绝：{item.tool}</>
        )}
      </div>
      {item.summary && <pre className="tl-pre tl-approval-summary">{item.summary}</pre>}
      {item.status === "pending" && (
        <div className="tl-approval-actions">
          <button className="tl-btn-allow" onClick={() => onApprove(item.requestId, true)}>
            允许
          </button>
          <button className="tl-btn-deny" onClick={() => onApprove(item.requestId, false)}>
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 问卷卡片：ask_user 提问（等待作答 / 已作答 / 已取消 / 已超时）。
 * 待答时可单选/多选 + 「其他」自由输入，一次提交全部作答；终态只读展示。
 */
function QuestionCard({
  item,
  onAnswerQuestion,
}: {
  item: Extract<TimelineItem, { kind: "question" }>;
  onAnswerQuestion: (
    requestId: string,
    payload: { answers?: Record<string, { selected: string[]; custom?: string }>; cancelled?: boolean }
  ) => void;
}) {
  const spinner = useSpinner(item.status === "pending");
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});

  const toggleOption = (question: (typeof item.questions)[number], label: string) => {
    setPicked((prev) => {
      const current = prev[question.id] ?? [];
      if (question.multiple) {
        return {
          ...prev,
          [question.id]: current.includes(label)
            ? current.filter((l) => l !== label)
            : [...current, label],
        };
      }
      return { ...prev, [question.id]: current.includes(label) ? [] : [label] };
    });
  };

  const answeredAll = item.questions.every((q) => {
    const selected = picked[q.id] ?? [];
    const free = (custom[q.id] ?? "").trim();
    return selected.length > 0 || free.length > 0;
  });

  const submit = () => {
    const answers: Record<string, { selected: string[]; custom?: string }> = {};
    for (const q of item.questions) {
      const selected = picked[q.id] ?? [];
      const free = (custom[q.id] ?? "").trim();
      answers[q.id] = { selected, ...(free ? { custom: free } : {}) };
    }
    onAnswerQuestion(item.requestId, { answers });
  };

  const terminal = item.status !== "pending";
  return (
    <div className={`tl-question tl-question-${item.status}`}>
      <div className="tl-question-title">
        {item.status === "pending" ? (
          <>
            <span className="tl-approval-icon">{spinner}</span>需要你的回答
          </>
        ) : item.status === "answered" ? (
          <>✓ 已作答</>
        ) : item.status === "cancelled" ? (
          <>✗ 已取消提问</>
        ) : (
          <>⏱ 等待超时，Agent 已按未回答继续</>
        )}
      </div>
      <div className="tl-question-body">
        {item.questions.map((q) => {
          const selected = terminal ? item.answers?.[q.id]?.selected ?? [] : picked[q.id] ?? [];
          const customValue = terminal ? item.answers?.[q.id]?.custom ?? "" : custom[q.id] ?? "";
          const showOther = terminal ? !!customValue : otherOpen[q.id];
          return (
            <div key={q.id} className="tl-question-item">
              <div className="tl-question-prompt">
                {q.prompt}
                {q.multiple && <em className="tl-question-hint">可多选</em>}
              </div>
              <div className="tl-question-options">
                {q.options.map((option) => {
                  const active = selected.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={`tl-question-option${active ? " active" : ""}`}
                      disabled={terminal}
                      title={option.description ?? option.label}
                      onClick={() => toggleOption(q, option.label)}
                    >
                      {option.label}
                      {option.description && (
                        <span className="tl-question-option-desc">{option.description}</span>
                      )}
                    </button>
                  );
                })}
                {!terminal && q.allowOther !== false && (
                  <button
                    type="button"
                    className={`tl-question-option tl-question-other${showOther ? " active" : ""}`}
                    onClick={() => setOtherOpen((prev) => ({ ...prev, [q.id]: !prev[q.id] }))}
                  >
                    其他…
                  </button>
                )}
              </div>
              {showOther && (
                <input
                  className="tl-question-input"
                  placeholder="输入自定义答案"
                  value={customValue}
                  readOnly={terminal}
                  aria-label={`${q.prompt} 的自定义答案`}
                  onChange={(event) =>
                    setCustom((prev) => ({ ...prev, [q.id]: event.target.value }))
                  }
                />
              )}
            </div>
          );
        })}
      </div>
      {item.status === "pending" && (
        <div className="tl-approval-actions">
          <button className="tl-btn-allow" disabled={!answeredAll} onClick={submit}>
            提交
          </button>
          <button
            className="tl-btn-deny"
            onClick={() => onAnswerQuestion(item.requestId, { cancelled: true })}
          >
            取消提问
          </button>
        </div>
      )}
    </div>
  );
}

/** 用户消息：文本 + 可选图片缩略图 + 常显操作（从此分支 / 编辑重发） */
function UserItem({
  item,
  busy,
  editing,
  onBranch,
  onEditStart,
  onEditSubmit,
  onCancelEdit,
}: {
  item: Extract<TimelineItem, { kind: "user" }>;
  busy: boolean;
  /** 本条正处于气泡内联编辑态（由 App 单编辑器约束控制） */
  editing: boolean;
  onBranch: (fromSeq: number) => void;
  onEditStart: (seq: number) => void;
  onEditSubmit: (seq: number, text: string) => void;
  onCancelEdit: () => void;
}) {
  /** 内联草稿：进入编辑态时以原文初始化；null=未编辑 */
  const [draft, setDraft] = useState<string | null>(null);
  const draftText = draft ?? item.text;

  const startEdit = () => {
    if (typeof item.seq !== "number" || busy) return;
    setDraft(item.text);
    onEditStart(item.seq);
  };
  const cancelEdit = () => {
    setDraft(null);
    onCancelEdit();
  };
  const submitEdit = () => {
    if (typeof item.seq !== "number" || !draftText.trim() || busy) return;
    setDraft(null);
    onEditSubmit(item.seq, draftText.trim());
  };

  return (
    <div className="tl-user">
      <div className={`tl-user-body${editing ? " tl-user-body-editing" : ""}`}>
        {editing ? (
          <>
            <textarea
              className="tl-user-edit-input"
              value={draftText}
              autoFocus
              rows={2}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
            />
            <div className="tl-user-edit-hint">
              ✎ 提交后此消息之后的对话将被替换（原轨迹已备份）
            </div>
          </>
        ) : (
          <div className="tl-user-text">{item.text}</div>
        )}
        {!!item.images?.length && (
          <div className="tl-user-images">
            {item.images.map((img, i) => (
              <img
                key={i}
                className="tl-user-image"
                src={`data:${img.mimeType};base64,${img.data}`}
                alt="用户附件"
                onClick={() =>
                  window.open(`data:${img.mimeType};base64,${img.data}`, "_blank")
                }
              />
            ))}
          </div>
        )}
        {typeof item.seq === "number" && (
          <div className="tl-user-actions">
            {editing ? (
              <>
                <button className="tl-user-action" onClick={cancelEdit}>
                  取消
                </button>
                <button
                  className="tl-user-edit-submit"
                  disabled={busy || !draftText.trim()}
                  onClick={submitEdit}
                >
                  重新发送
                </button>
              </>
            ) : (
              <>
                <button
                  className="tl-user-action"
                  title="从此处分支：保留此轮及之前内容，创建可独立继续对话的新会话"
                  onClick={() => onBranch(item.seq!)}
                >
                  ⑂ 从此分支
                </button>
                <button
                  className="tl-user-action"
                  title={busy ? "执行中不可编辑，请先停止" : "编辑并重新发送：提交后此消息之后的对话将被替换"}
                  disabled={busy}
                  onClick={startEdit}
                >
                  ✎ 编辑重发
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 输入区浮层：slash 命令 / @ 文件补全 */
interface PaletteState {
  mode: "command" | "file";
  query: string;
  /** @ 模式：当前浏览的项目相对目录 */
  dir: string;
  /** @ 触发词在输入中的起始位置（替换用） */
  at: number;
}

export default function TimelinePanel({
  sidebarOpen,
  onToggleSidebar,
  session,
  items,
  busy,
  input,
  setInput,
  models,
  defaultModel,
  usage,
  onSend,
  onCancel,
  queue,
  onQueueForce,
  onQueueRemove,
  onApprove,
  onAnswerQuestion,
  onModeSelect,
  onExecutePlan,
  onRename,
  onModelChange,
  onSetDefaultModel,
  onThinkingChange,
  onCompact,
  onBranch,
  editing,
  onEditStart,
  onEditSubmit,
  onCancelEdit,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** 智能滚动跟随：用户上滚离开底部时暂停自动跟随 */
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);

  /** 待发送图片（base64，发送成功后清空） */
  const [pendingImages, setPendingImages] = useState<UserMessageImage[]>([]);
  /** 浮层状态（null=隐藏） */
  const [palette, setPalette] = useState<PaletteState | null>(null);
  const [commands, setCommands] = useState<SessionCommand[]>([]);
  const [fileEntries, setFileEntries] = useState<ProjectFileEntry[]>([]);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [contextOpen, setContextOpen] = useState(false);
  /** 顶栏标题内联重命名（null=非编辑态；不用 window.prompt，Electron 不支持） */
  const [editingTitle, setEditingTitle] = useState<string | null>(null);

  // 切换会话时清空输入态并回到底部
  useEffect(() => {
    setPendingImages([]);
    setPalette(null);
    setCommands([]);
    atBottomRef.current = true;
    setAtBottom(true);
  }, [session?.id]);

  // 自动跟随滚动（用户主动上滚时不打扰）
  useEffect(() => {
    if (!atBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items]);

  // 输入框自动增高（内容驱动，1~约 6 行）
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // 会话确定后预取命令（/ 面板用）
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetchCommands(session.id)
      .then((r) => !cancelled && setCommands(r.commands))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session?.id]);

  // 浮层目录内容加载
  useEffect(() => {
    if (!session || !palette || palette.mode !== "file") return;
    let cancelled = false;
    fetchProjectFiles(session.id, palette.dir)
      .then((r) => !cancelled && setFileEntries(r.entries))
      .catch(() => !cancelled && setFileEntries([]));
    return () => {
      cancelled = true;
    };
  }, [session?.id, palette?.mode, palette?.dir]);

  const handleTimelineScroll = () => {
    const el = timelineRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const now = distance < 80;
    atBottomRef.current = now;
    setAtBottom(now);
  };

  const scrollToBottom = () => {
    atBottomRef.current = true;
    setAtBottom(true);
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  /** 输入变化：检测 / 与 @ 触发词并刷新浮层 */
  const detectTrigger = (value: string, caret: number) => {
    const beforeCaret = value.slice(0, caret);
    if (value.startsWith("/") && !value.includes(" ")) {
      setPalette({ mode: "command", query: value.slice(1), dir: "", at: 0 });
      setPaletteIndex(0);
      return;
    }
    const at = beforeCaret.lastIndexOf("@");
    if (at >= 0 && !/\s/.test(beforeCaret.slice(at + 1))) {
      const token = beforeCaret.slice(at + 1);
      const dir = token.includes("/") ? token.slice(0, token.lastIndexOf("/") + 1) : "";
      setPalette({ mode: "file", query: token, dir, at });
      setPaletteIndex(0);
      return;
    }
    setPalette(null);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    detectTrigger(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  /**
   * 已执行计划的 key 集合：倒序扫描，遇到用户消息后，更早的 submit_plan 即视为已执行。
   * 这样切回 plan 模式时旧计划卡片不会复活「按此计划执行」按钮；最新提交的计划
   * 位于用户消息之后，不受影响。（实现提取在 timeline.ts，供回放回归测试共用）
   */
  const executedPlanKeys = useMemo(() => computeExecutedPlans(items), [items]);

  /** 浮层候选（按 query 前缀过滤） */
  const paletteItems = useMemo(() => {
    if (!palette) return [] as { label: string; description?: string; detail?: string }[];
    if (palette.mode === "command") {
      const q = palette.query.toLowerCase();
      return commands
        .filter((c) => !q || c.name.toLowerCase().includes(q))
        .map((c) => ({
          label: c.name,
          description: c.description,
          detail: c.source === "skill" ? "技能" : "模板",
        }));
    }
    const q = palette.query.split("/").pop()?.toLowerCase() ?? "";
    return fileEntries
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .map((f) => ({ label: f.relativePath, description: undefined, detail: f.directory ? "目录" : undefined }));
  }, [palette, commands, fileEntries]);

  /** 应用浮层选中项到输入框 */
  const applyPaletteItem = (index: number) => {
    const item = paletteItems[index];
    if (!palette || !item || !session) return;
    if (palette.mode === "command") {
      setInput(`${item.label} `);
      setPalette(null);
      textareaRef.current?.focus();
      return;
    }
    // 文件：目录则进入该目录继续浏览；文件则插入路径并关闭
    const isDir = item.label.endsWith("/");
    const replaced = `${input.slice(0, palette.at)}@${item.label}`;
    if (isDir) {
      setInput(`${replaced}`);
      setPalette({ ...palette, dir: item.label, query: item.label, at: palette.at });
      setPaletteIndex(0);
    } else {
      setInput(`${replaced}${input.slice(palette.at + 1 + palette.query.length)}`);
      setPalette(null);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (palette && paletteItems.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPaletteIndex((i) => (i + 1) % paletteItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPaletteIndex((i) => (i - 1 + paletteItems.length) % paletteItems.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        applyPaletteItem(paletteIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPalette(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendInternal();
    }
  };

  const addImages = (files: FileList | File[] | null) => {
    if (!files) return;
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    for (const file of images) {
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result).split(",")[1] ?? "";
        if (data) setPendingImages((prev) => [...prev, { mimeType: file.type, data }]);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSendInternal = () => {
    if (!session || !input.trim()) return;
    const images = pendingImages.length ? pendingImages : undefined;
    setPendingImages([]);
    setPalette(null);
    // 运行中不拦截：由 App 侧进入该会话的发送队列
    onSend(images);
  };

  /** 是否需要显示"等待开始输出"的思考指示（忙碌但既无流式文本也无运行中工具/思考） */
  const last = items[items.length - 1];
  const showPending =
    busy &&
    !(last && ((last.kind === "assistant" || last.kind === "thinking") && last.streaming)) &&
    !items.some((it) => it.kind === "tool" && it.status === "running") &&
    !items.some((it) => it.kind === "approval" && it.status === "pending") &&
    !items.some((it) => it.kind === "question" && it.status === "pending");
  const pendingSpinner = useSpinner(showPending);

  /** 当前会话模型（无会话级选择时为应用默认；都没有显示 env 默认） */
  const activeModelKey = (() => {
    const m = session?.model ?? defaultModel;
    return m ? `${m.providerId}/${m.modelId}` : "";
  })();
  const activeModel = models.find((m) => `${m.providerId}/${m.modelId}` === activeModelKey);
  /** 当前模型是否支持图片输入 */
  const modelSupportsImage = activeModel ? activeModel.input.includes("image") : true;

  /** 模型按 provider 分组（下拉 optgroup） */
  const modelGroups = useMemo(() => {
    const groups = new Map<string, AvailableModel[]>();
    for (const m of models) {
      const list = groups.get(m.providerId) ?? [];
      list.push(m);
      groups.set(m.providerId, list);
    }
    return groups;
  }, [models]);

  /** 思考强度：该模型可用档位序列（off 恒可用；选 off 即关闭思考） */
  const availableThinking = activeModel?.thinkingLevels?.length
    ? THINKING_LEVELS.filter((l) => activeModel.thinkingLevels.includes(l))
    : THINKING_LEVELS;
  const thinkingSupported = availableThinking.length > 1;
  const currentThinking = session?.thinkingLevel ?? "medium";
  // 下拉显示值：当前档位不在该模型可用档位内时，回落到 off（再退到首档）
  const thinkingValue = availableThinking.includes(currentThinking)
    ? currentThinking
    : availableThinking.includes("off")
      ? "off"
      : availableThinking[0];

  /** 上下文占用条：真实 usage.input ÷ 当前模型窗口 */
  const contextWindow = activeModel?.contextWindow ?? 0;
  const contextPercent =
    usage && contextWindow > 0 ? Math.min(100, (usage.input / contextWindow) * 100) : null;

  /** 单条时间线条目渲染（平铺与「执行过程」折叠组共用） */
  const renderItem = (item: TimelineItem) => {
    switch (item.kind) {
      case "user":
        return (
          <UserItem
            key={item.key}
            item={item}
            busy={busy}
            editing={!!editing && editing.seq === item.seq}
            onBranch={onBranch}
            onEditStart={onEditStart}
            onEditSubmit={onEditSubmit}
            onCancelEdit={onCancelEdit}
          />
        );
      case "assistant":
        return (
          <div key={item.key} className="tl-assistant">
            <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
            {item.streaming && <span className="cursor">▌</span>}
          </div>
        );
      case "thinking":
        return <ThinkingItem key={item.key} item={item} />;
      case "tool":
        if (item.tool === "submit_plan") {
          return (
            <PlanCard
              key={item.key}
              item={item}
              mode={session?.mode}
              busy={busy}
              executed={executedPlanKeys.has(item.key)}
              onExecutePlan={onExecutePlan}
            />
          );
        }
        return <ToolItem key={item.key} item={item} />;
      case "approval":
        return <ApprovalItem key={item.key} item={item} onApprove={onApprove} />;
      case "question":
        return (
          <QuestionCard key={item.key} item={item} onAnswerQuestion={onAnswerQuestion} />
        );
      case "error":
        return (
          <div key={item.key} className="tl-error">
            ✗ {item.text}
          </div>
        );
      case "system":
        return (
          <div key={item.key} className={`tl-system tl-system-${item.subtype}`}>
            {item.subtype === "compacting" ? "⏳" : "⤡"} {item.text}
          </div>
        );
      case "turnEnd":
        return null;
    }
  };

  /** 可收进「执行过程」的条目：思考/工具（计划卡保留可见）/审批/提问/非最终回复 */
  const isProcessItem = (item: TimelineItem) =>
    item.kind === "thinking" ||
    (item.kind === "tool" && item.tool !== "submit_plan") ||
    item.kind === "approval" ||
    item.kind === "question" ||
    item.kind === "assistant";

  /** 按用户消息把时间线切分为轮次（一轮 = 用户消息 + 其后的过程与回答） */
  const turns = useMemo(() => {
    const groups: { key: string; items: TimelineItem[] }[] = [];
    for (const item of items) {
      if (item.kind === "user" || !groups.length) {
        groups.push({ key: item.key, items: [item] });
      } else {
        groups[groups.length - 1].items.push(item);
      }
    }
    return groups;
  }, [items]);

  /**
   * 渲染一轮：过程条目（思考/工具/审批/中间回复）收进「执行过程」折叠组，最终回答常显在组后。
   * 结束判定 = 末尾有 turnEnd 标记（session.completed 追加，已落盘、回放一致）或不是最后一轮。
   * 组在开始时即出现（running 态默认展开），结束后由 ProcessGroup 自动折叠一次。
   * 计划轮次（含 submit_plan）里计划卡片就是本轮产物：计划前后的说明文字全部常显，只折叠思考与工具。
   */
  const renderTurn = (turn: { key: string; items: TimelineItem[] }, isLast: boolean) => {
    const [head, ...rest] = turn.items;
    const content = rest.filter((item) => item.kind !== "turnEnd");
    const finished = !isLast || rest[rest.length - 1]?.kind === "turnEnd";
    if (head.kind !== "user" || !content.length) {
      return turn.items.map(renderItem);
    }
    const planTurn = content.some((item) => item.kind === "tool" && item.tool === "submit_plan");
    const isProcess = (item: TimelineItem) =>
      planTurn
        ? item.kind === "thinking" ||
          (item.kind === "tool" && item.tool !== "submit_plan") ||
          item.kind === "approval"
        : isProcessItem(item);
    const last = content[content.length - 1];
    // 计划轮次的产物是计划卡片，不能把最后一条 assistant 当作最终回答而让其它说明文字进组
    const finalAnswer = !planTurn && last.kind === "assistant" ? last : null;
    const processItems = content.filter((item) => item !== finalAnswer && isProcess(item));
    if (!processItems.length) return turn.items.map(renderItem);

    const nodes: React.ReactNode[] = [renderItem(head)];
    let grouped = false;
    for (const item of content) {
      if (item === finalAnswer) continue;
      if (isProcess(item)) {
        if (!grouped) {
          nodes.push(
            <ProcessGroup
              key={`p-${turn.key}`}
              items={processItems}
              renderItem={renderItem}
              running={!finished}
            />
          );
          grouped = true;
        }
        continue;
      }
      nodes.push(renderItem(item));
    }
    if (finalAnswer) nodes.push(renderItem(finalAnswer));
    return nodes;
  };

  return (
    <section className="timeline-panel">
      <div className="chat-header">
        <button type="button" className="sidebar-toggle" aria-label="打开项目与会话列表" aria-controls="app-sidebar" aria-expanded={sidebarOpen} onClick={onToggleSidebar}>☰</button>
        <div className="chat-header-info">
          {session ? (
            <>
              {editingTitle === null ? (
                <>
                  <span className="chat-title" title={session.title?.trim() || "新建会话"}>{session.title?.trim() || "新建会话"}</span>
                  <button
                    className="chat-rename-btn"
                    title="重命名会话"
                    onClick={() => setEditingTitle(session.title ?? "")}
                  >
                    ✎
                  </button>
                </>
              ) : (
                <input
                  className="chat-title-input"
                  value={editingTitle}
                  autoFocus
                  placeholder="会话标题"
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const t = editingTitle.trim();
                      setEditingTitle(null);
                      if (t) onRename(t);
                    } else if (e.key === "Escape") {
                      setEditingTitle(null);
                    }
                  }}
                  onBlur={() => {
                    const t = editingTitle.trim();
                    setEditingTitle(null);
                    if (t && t !== (session.title ?? "").trim()) onRename(t);
                  }}
                />
              )}
              {session.parentSessionId && (
                <span className="chat-branch-badge" title={`分支自会话 ${session.parentSessionId.slice(0, 8)}`}>
                  ⑂ 分支
                </span>
              )}
              {session.projectPath ? (
                <span className="chat-path" title={session.projectPath}>
                  {session.projectPath}
                </span>
              ) : (
                <span className="chat-path chat-path-internal" title="会话隔离工作区">
                  隔离工作区
                </span>
              )}
            </>
          ) : <span>未选择会话</span>}
        </div>
        <div className="chat-header-actions">
          {session && <>
            {busy && <span className="chat-busy-dot" title="执行中" />}
            <span className={`status-badge status-${session.status}`}>{session.status}</span>
            <RowMenu label="当前会话更多操作" actions={[
              { label: "压缩上下文", onSelect: onCompact, disabled: busy },
              ...(activeModelKey && activeModel ? [{ label: "设当前模型为默认", onSelect: () => onSetDefaultModel({
                providerId: activeModel.providerId, modelId: activeModel.modelId,
              }) }] : []),
            ]} />
          </>}
          <WinControls />
        </div>
      </div>

      <div className="timeline-wrap">
        <div className="timeline" ref={timelineRef} onScroll={handleTimelineScroll}>
          {turns.map((turn, index) => renderTurn(turn, index === turns.length - 1))}
          {showPending && (
            <div className="tl-pending">
              <span className="tl-pending-spinner">{pendingSpinner}</span>思考中…
            </div>
          )}
          {!session && (
            <div className="chat-placeholder">左侧新建会话后开始对话</div>
          )}
          <div ref={bottomRef} />
        </div>
        {!atBottom && !!items.length && (
          <button className="jump-bottom" title="回到底部" onClick={scrollToBottom}>
            ↓
          </button>
        )}
      </div>

      <div className="chat-input-area">
        <div className="chat-input-wrap">
          {palette && paletteItems.length > 0 && (
            <div className="palette">
              <div className="palette-title">
                {palette.mode === "command" ? "命令（Enter/Tab 选中）" : `文件 @${palette.dir || ""}`}
              </div>
              {paletteItems.slice(0, 10).map((item, i) => (
                <button
                  key={item.label}
                  className={`palette-item ${i === paletteIndex ? "active" : ""}`}
                  onMouseEnter={() => setPaletteIndex(i)}
                  onClick={() => applyPaletteItem(i)}
                >
                  <span className="palette-label">{item.label}</span>
                  {item.description && <span className="palette-desc">{item.description}</span>}
                  {item.detail && <span className="palette-detail">{item.detail}</span>}
                </button>
              ))}
            </div>
          )}
          {!!queue.length && (
            <div className="chat-queue">
              {queue.map((m) => (
                <div
                  key={m.key}
                  className="chat-queue-item"
                  role="button"
                  tabIndex={0}
                  title="点击立即打断当前输出并发送这条消息"
                  onClick={() => onQueueForce(m.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onQueueForce(m.key);
                    }
                  }}
                >
                  <span className="chat-queue-text">{m.text}</span>
                  <span className="chat-queue-hint">⚡ 打断并发送</span>
                  <button
                    className="chat-queue-remove"
                    title="从队列移除"
                    onClick={(e) => {
                      e.stopPropagation();
                      onQueueRemove(m.key);
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          {!!pendingImages.length && (
            <div className="pending-images">
              {pendingImages.map((img, i) => (
                <div key={i} className="pending-image-wrap">
                  <img className="pending-image" src={`data:${img.mimeType};base64,${img.data}`} alt="待发送" />
                  <button
                    className="pending-image-remove"
                    title="移除"
                    onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <div
            className="chat-input"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files.length) addImages(e.dataTransfer.files);
            }}
          >
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={(e) => {
                if (e.clipboardData.files.length) {
                  e.preventDefault();
                  addImages(e.clipboardData.files);
                }
              }}
              placeholder={
                !session
                  ? "请先创建会话"
                  : busy
                    ? "执行中——Enter 发送将排队，点击队列消息可打断并立即发送"
                    : session.mode === "plan"
                      ? "规划模式：只读调研。Enter 发送，/ 命令，@ 引用文件"
                      : "输入消息，Enter 发送，/ 命令，@ 引用文件；直接粘贴或拖入图片"
              }
              disabled={!session}
              rows={1}
            />
            {busy ? (
              <button className="send-btn send-stop" onClick={onCancel} title="停止当前执行">
                ■
              </button>
            ) : (
              <button
                className="send-btn"
                onClick={handleSendInternal}
                disabled={!session || !input.trim()}
                title="发送（Enter）"
              >
                ▶
              </button>
            )}
          </div>
        </div>
        {!modelSupportsImage && !!pendingImages.length && (
          <div className="image-warning">
            当前模型不支持图片输入，请切换到带 📷 标记的模型后再发送。
          </div>
        )}
        {/* 底部状态条：输入框下方一行收纳 模式 / 模型 / 思考强度 / 上下文占用（Claude Code 风格） */}
        {session && (
          <div className="chat-statusbar">
            <div className="mode-switch">
              <button
                className={`mode-option mode-option-plan ${session.mode === "plan" ? "active" : ""}`}
                onClick={() => onModeSelect("plan")}
                title="规划模式：只读调研并提交计划"
              >
                Plan
              </button>
              <button
                className={`mode-option ${session.mode === "act" && session.permissions.approval !== "full" ? "active" : ""}`}
                onClick={() => onModeSelect("act")}
                title="执行模式（智能批准）：只读命令与工作区内文件操作（mkdir/cp/重定向/装包/git 提交）自动放行；其余命令与 openGIS 需确认，写入限项目内且受保护文件禁止"
              >
                Act
              </button>
              <button
                className={`mode-option mode-option-yolo ${session.mode === "act" && session.permissions.approval === "full" ? "active" : ""}`}
                onClick={() => onModeSelect("yolo")}
                title="YOLO（完全访问）：跳过全部审批；写入仍限项目内，受保护文件（.env/.git 等）禁止"
              >
                YOLO
              </button>
            </div>
            <Dropdown
              className="model-select"
              value={activeModelKey}
              onChange={(v) => {
                const chosen = models.find((m) => `${m.providerId}/${m.modelId}` === v);
                if (chosen) onModelChange({ providerId: chosen.providerId, modelId: chosen.modelId });
              }}
              title="切换会话模型（重启恢复保持）"
              placeholder="（默认）"
              minWidth={220}
              groups={[
                ...(activeModelKey ? [] : [{ options: [{ value: "", label: "（默认）", disabled: true }] }]),
                ...[...modelGroups.entries()].map(([providerId, group]) => ({
                  label: providerId,
                  options: group.map((m) => ({
                    value: `${m.providerId}/${m.modelId}`,
                    label: m.name,
                    hint: m.input.includes("image") ? "📷" : undefined,
                  })),
                })),
              ]}
            />
            <Dropdown
              className={`thinking-pill ${thinkingSupported ? "" : "disabled"}`}
              value={thinkingSupported ? thinkingValue : ""}
              onChange={(v) => {
                const level = availableThinking.find((l) => l === v);
                if (level) onThinkingChange(level);
              }}
              title={
                thinkingSupported
                  ? "思考强度（选 off 关闭思考）"
                  : "当前模型不支持思考（内置档案判定为非推理系列）"
              }
              placeholder="不可用"
              disabled={!thinkingSupported || busy}
              icon={<span className="thinking-pill-icon">◆</span>}
              groups={
                thinkingSupported
                  ? [{ options: availableThinking.map((level) => ({ value: level, label: level })) }]
                  : []
              }
            />
            <span className="chat-statusbar-spacer" />
            <button
              className="context-usage"
              title="上下文占用详情"
              disabled={!session}
              onClick={() => setContextOpen(true)}
            >
              <span className="context-usage-text">
                {usage && contextWindow > 0
                  ? `${contextPercent!.toFixed(0)}% · ${(usage.input / 1000).toFixed(1)}k/${(contextWindow / 1000).toFixed(0)}k`
                  : "上下文"}
              </span>
              <span className="context-usage-bar">
                <span
                  className={`context-usage-fill ${
                    (contextPercent ?? 0) >= 90 ? "danger" : (contextPercent ?? 0) >= 70 ? "warn" : ""
                  }`}
                  style={{ width: `${contextPercent ?? 0}%` }}
                />
              </span>
            </button>
          </div>
        )}
      </div>

      {contextOpen && session && (
        <ContextDetail sessionId={session.id} onClose={() => setContextOpen(false)} />
      )}
    </section>
  );
}
