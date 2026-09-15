/**
 * 常用模型系列内置档案：上游探测不到能力时的兜底自动填写。
 *
 * 优先级：上游 /models 自报 > 网关 /api/pricing 分档 > 本表 > 全局默认（256k / 支持思考 / 全档位）。
 * 本表按模型 id 正则匹配（自上而下首个命中生效），数值为经验值，可直接增删或修改条目；
 * 上游真实返回的值永远优先，本表只在对应字段缺省时填补。
 *
 * 数据来源（2026-09 核对官方文档）：
 * - DeepSeek：api-docs.deepseek.com 模型定价页（V4-Pro/Flash/Vision 均 1M 上下文、
 *   最大输出 384K）+ 思考模式指南（OpenAI 格式 reasoning_effort 可传 low/high/max，
 *   medium→high、xhigh→high，默认 high）
 * - Kimi：platform.kimi.com 定价页（K3 为 1M 上下文）
 * - GLM：docs.bigmodel.cn（GLM-4.6 200K 上下文、支持深度思考、纯文本）
 * - MiniMax：platform.minimaxi.com（M1 为 1M 输入）
 * - 其余系列（GPT/Claude/Gemini/Qwen/Grok）官方站点在探测环境不可达或未给出最新值，
 *   取公开已知的经验值；如与实际不符，直接改本表或让上游自报即可。
 *
 * thinkingLevelMap 语义（对应 SDK getSupportedThinkingLevels）：
 * - 值为 null：该档位从「思考强度」下拉中移除；
 * - xhigh / max 需显式给出非 null 值才会出现；
 * - 其余档位默认出现，给字符串可改写发给上游的档位名。
 * 例如 { minimal: null, medium: null, xhigh: null, max: "max" } → 可用档位 off/low/high/max。
 */
export interface ModelProfile {
  /** 模型 id 匹配规则（不区分大小写） */
  match: RegExp;
  /** 上下文窗口（token） */
  contextWindow?: number;
  /** 是否支持推理（思考强度下拉的开关依据） */
  reasoning?: boolean;
  /** 思考档位映射（可用档位与上游档位名） */
  thinkingLevelMap?: Record<string, string | null>;
  /** 输入模态（含 image 时给出） */
  input?: string[];
  /** 条目说明（维护用） */
  note: string;
}

/** DeepSeek V4 思考档位：上游只认 low/high/max（medium/xhigh 会被归一到 high，这里直接不展示） */
const DEEPSEEK_THINKING: Record<string, string | null> = {
  minimal: null,
  medium: null,
  xhigh: null,
  max: "max",
};

export const BUILTIN_MODEL_PROFILES: ModelProfile[] = [
  {
    match: /deepseek.*vision|vision.*deepseek/i,
    contextWindow: 1_000_000,
    reasoning: true,
    thinkingLevelMap: DEEPSEEK_THINKING,
    input: ["text", "image"],
    note: "DeepSeek V4 视觉实验版：1M 上下文，图片输入，思考档位 low/high/max",
  },
  {
    match: /deepseek/i,
    contextWindow: 1_000_000,
    reasoning: true,
    thinkingLevelMap: DEEPSEEK_THINKING,
    note: "DeepSeek 系列：1M 上下文，思考档位 low/high/max",
  },
  {
    match: /gpt-4\.1/i,
    contextWindow: 1_000_000,
    reasoning: false,
    input: ["text", "image"],
    note: "GPT-4.1：1M 上下文，多模态，非推理",
  },
  {
    match: /gpt-4o/i,
    contextWindow: 128_000,
    reasoning: false,
    input: ["text", "image"],
    note: "GPT-4o：128k 上下文，多模态，非推理",
  },
  {
    match: /(^|[-_/])(gpt-5|gpt-6|o1|o3|o4|o5)/i,
    contextWindow: 400_000,
    reasoning: true,
    input: ["text", "image"],
    note: "OpenAI 推理系列（GPT-5/6、o 系列）：400k 上下文，多模态",
  },
  {
    match: /claude/i,
    contextWindow: 200_000,
    reasoning: true,
    input: ["text", "image"],
    note: "Claude 系列：200k 上下文，多模态",
  },
  {
    match: /gemini/i,
    contextWindow: 1_000_000,
    reasoning: true,
    input: ["text", "image"],
    note: "Gemini 系列：1M 上下文，多模态",
  },
  {
    match: /qwen/i,
    contextWindow: 256_000,
    reasoning: true,
    note: "Qwen 系列：256k 上下文",
  },
  {
    match: /kimi/i,
    contextWindow: 1_000_000,
    reasoning: true,
    note: "Kimi 系列：K3 为 1M 上下文",
  },
  {
    match: /glm/i,
    contextWindow: 200_000,
    reasoning: true,
    note: "GLM 系列：200k 上下文（4.6 官方值）",
  },
  {
    match: /grok/i,
    contextWindow: 256_000,
    reasoning: true,
    note: "Grok 系列：256k 上下文",
  },
  {
    match: /minimax/i,
    contextWindow: 1_000_000,
    reasoning: true,
    note: "MiniMax 系列：M1 为 1M 输入",
  },
];

/** 按模型 id 匹配内置档案（未命中返回 undefined） */
export function matchModelProfile(modelId: string): ModelProfile | undefined {
  return BUILTIN_MODEL_PROFILES.find((profile) => profile.match.test(modelId));
}
