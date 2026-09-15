/**
 * ask_user 工具（Agent 向用户结构化提问并等待回答）——SDK customTools 模块。
 *
 * 交互模型（与官方示例 question.ts / questionnaire.ts 同构，但适配本项目的进程内
 * print 模式：官方示例走 TUI 的 ctx.ui.custom，在无终端 UI 时不可用）：
 * 工具 execute 内 `await ask(...)` 挂起本轮运行 → 服务端 emit `question.required`
 * 事件（SSE 推给前端问卷卡片）→ 用户在前端作答 → `POST /api/sessions/:id/question`
 * 回传 → 桥 resolve Promise → 答案作为工具结果文本进入模型上下文。
 *
 * 与审批（approvalGate）的关系：同一套「挂起—回传」机制，区别是 resolve 载荷从
 * 布尔换成结构化答案；本工具自身不是执行类动作（不修改任何数据），因此免审批，
 * 且 plan 模式可用（规划阶段澄清需求）。
 */

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** 单个提问选项 */
export interface AskUserOption {
  label: string;
  description?: string;
}

/** 单个问题（一次调用可问 1~4 题） */
export interface AskUserQuestion {
  id: string;
  prompt: string;
  options: AskUserOption[];
  /** 是否多选（默认单选） */
  multiple?: boolean;
  /** 是否提供「其他」自由输入（默认提供） */
  allowOther?: boolean;
}

/** 用户对单题的回答 */
export interface AskUserAnswer {
  /** 选中的选项 label 列表（多选时多个） */
  selected: string[];
  /** 「其他」自由输入内容（未使用则省略） */
  custom?: string;
}

/** 提问的终态载荷（question.answered 事件内容 / 桥的 resolve 值） */
export interface AskUserResult {
  /** 用户对 request_id 的作答（按题 id 索引）；cancelled/timeout 时为空 */
  answers?: Record<string, AskUserAnswer>;
  /** 用户主动取消本次提问 */
  cancelled?: boolean;
  /** 超过等待时限，用户未回答 */
  timeout?: boolean;
}

export interface AskUserToolOptions {
  /** 提问桥（由 piAdapter 注入：登记 pending、emit 事件、等待 HTTP 回传） */
  ask: (questions: AskUserQuestion[]) => Promise<AskUserResult>;
}

/** 校验并归一化模型给出的问题清单 */
export function normalizeQuestions(raw: AskUserQuestion[]): AskUserQuestion[] {
  const questions = raw.map((q) => ({
    id: String(q.id ?? "").trim(),
    prompt: String(q.prompt ?? "").trim(),
    options: (q.options ?? []).map((o) => ({
      label: String(o.label ?? "").trim(),
      ...(o.description?.trim() ? { description: o.description.trim() } : {}),
    })),
    ...(q.multiple === true ? { multiple: true } : {}),
    ...(q.allowOther === false ? { allowOther: false } : {}),
  }));
  if (questions.length < 1 || questions.length > 4) {
    throw new Error(`questions 需要 1~4 题（收到 ${questions.length} 题）`);
  }
  const seen = new Set<string>();
  for (const q of questions) {
    if (!q.id) throw new Error("每个问题都需要非空 id");
    if (seen.has(q.id)) throw new Error(`问题 id 重复: ${q.id}`);
    seen.add(q.id);
    if (!q.prompt) throw new Error(`问题 ${q.id} 缺少 prompt（题干）`);
    if (q.options.length < 2 || q.options.length > 6) {
      throw new Error(`问题 ${q.id} 需要 2~6 个选项（收到 ${q.options.length} 个）`);
    }
    if (q.options.some((o) => !o.label)) throw new Error(`问题 ${q.id} 存在空选项 label`);
  }
  return questions;
}

/** 把终态答案渲染为回传给模型的文本 */
export function renderAnswerText(questions: AskUserQuestion[], result: AskUserResult): string {
  if (result.cancelled) {
    return "用户取消了本次提问（未回答）。请勿原样重复提问；如需继续，先向用户说明再调整方案。";
  }
  if (result.timeout) {
    return "用户未在时限内回答本次提问。请基于合理假设继续（并在回复中说明假设），或停下等待用户回来；不要重复提问同一内容。";
  }
  const answers = result.answers ?? {};
  const lines = questions.map((q) => {
    const answer = answers[q.id];
    if (!answer) return `- [${q.id}] ${q.prompt} → （未回答）`;
    const parts = [...answer.selected];
    if (answer.custom) parts.push(`其他：${answer.custom}`);
    const kind = q.multiple ? "多选" : "单选";
    return `- [${q.id}] ${q.prompt}（${kind}）→ ${parts.join("、") || "（未选择）"}`;
  });
  return `用户回答了本次提问：\n${lines.join("\n")}`;
}

export function createAskUserTool(options: AskUserToolOptions): ToolDefinition {
  return defineTool({
    name: "ask_user",
    label: "询问用户",
    description:
      "向用户发起结构化提问并等待回答，用于需求存在歧义、多个方案会产生不同结果、" +
      "或需要用户提供关键参数/偏好时（用户回答前本轮暂停）。" +
      "一次可问 1~4 题（每题 2~6 个选项，可单选/多选，前端始终提供「其他」自由输入）；" +
      "不要把能从代码/数据中自行查明的事情拿来提问，也不要用它请求执行许可（那是审批的职责）。" +
      "用户可能取消或超时未答，届时应基于合理假设继续或先说明再停下。",
    promptSnippet: "ask the user structured question(s) and wait for the answer",
    promptGuidelines: [
      "需要用户决策且不同选项会导致不同结果时，用 ask_user 提问，而不是在回复里罗列问题让用户手动回复。",
      "提问前先自行调研代码与数据；能查到答案的不要问。",
    ],
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          id: Type.String({ description: "本题标识（英文/数字，用于回传答案，需唯一）" }),
          prompt: Type.String({ description: "题干（一句话，写清要用户决定什么）" }),
          options: Type.Array(
            Type.Object({
              label: Type.String({ description: "选项文本（简短）" }),
              description: Type.Optional(
                Type.String({ description: "选项补充说明（可选，解释差异或后果）" })
              ),
            }),
            {
              minItems: 2,
              maxItems: 6,
              description: "选项列表（2~6 个）",
            }
          ),
          multiple: Type.Optional(
            Type.Boolean({ description: "是否允许多选（默认单选）" })
          ),
          allowOther: Type.Optional(
            Type.Boolean({ description: "是否提供「其他」自由输入（默认提供）" })
          ),
        }),
        { minItems: 1, maxItems: 4, description: "问题列表（1~4 题）" }
      ),
    }),
    // 顺序执行：避免与其他工具并发时抢占用户注意力（对齐官方 question.ts）
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const questions = normalizeQuestions(params.questions as AskUserQuestion[]);
      const result = await options.ask(questions);
      return {
        content: [{ type: "text" as const, text: renderAnswerText(questions, result) }],
        details: {
          questions,
          ...(result.answers ? { answers: result.answers } : {}),
          ...(result.cancelled ? { cancelled: true } : {}),
          ...(result.timeout ? { timeout: true } : {}),
        },
      };
    },
  });
}
