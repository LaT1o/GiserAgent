/**
 * 模型提供商管理（文件层 + 上游探测，不含 runtime 编排）。
 *
 * 职责划分：
 * - 本文件：models.json / auth.json 的结构化读写，以及「探测上游 /models 列表」
 *   的纯 HTTP 函数（OpenAI 兼容格式，不落盘）
 * - piAdapter：添加/删除/导入模型的运行时编排（写文件 + registerProvider
 *   内存注册，让已激活会话立即可见，重启后由文件恢复）
 *
 * 密钥策略：真实 API Key 只写 server/.pi/auth.json（gitignored，SDK 凭据
 * 优先级 auth.json > models.json）；models.json 不含密钥，保持可提交。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { matchModelProfile } from "./modelProfiles.js";

/** models.json 中单个 provider 条目（未知字段原样保留） */
export interface ProviderFileEntry {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: ModelFileEntry[];
  [key: string]: unknown;
}

/** models.json 中单个模型条目 */
export interface ModelFileEntry {
  id: string;
  name?: string;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  /** 推理模型标记（思考强度滑块依据；pi 侧 Model.reasoning） */
  reasoning?: boolean;
  /** 思考档位 → 上游原生档位名映射（xhigh/max 必须显式出现才可用，null 表示不支持） */
  thinkingLevelMap?: Record<string, string | null>;
  [key: string]: unknown;
}

export interface ModelsFile {
  providers: Record<string, ProviderFileEntry>;
  [key: string]: unknown;
}

export interface AuthFile {
  [providerId: string]: { type: "api_key"; key: string };
}

/** 对外展示的 provider 摘要（不含密钥明文） */
export interface ProviderInfo {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  modelCount: number;
  /** auth.json 中存有密钥 */
  hasStoredKey: boolean;
}

/** 上游 /models 返回的模型条目（能力字段视网关实现可能缺失） */
export interface UpstreamModel {
  id: string;
  name?: string;
  /** 上游自报上下文窗口（token） */
  contextWindow?: number;
  /** 上游自报是否支持推理 */
  reasoning?: boolean;
  /** 上游自报输入模态（仅识别 image，命中时为 ["text","image"]） */
  input?: string[];
  /** 思考档位映射（来自内置系列档案时一并带出） */
  thinkingLevelMap?: Record<string, string | null>;
}

/** 上游上下文字段候选名（不同网关命名不一，取首个正数） */
const CONTEXT_WINDOW_KEYS = [
  "context_length",
  "context_window",
  "max_context_length",
  "max_model_len",
  "max_input_tokens",
  "input_token_limit",
  "n_ctx",
] as const;

/** 解析上游条目中的上下文窗口（取首个正数，忽略非数值） */
function pickContextWindow(entry: Record<string, unknown>): number | undefined {
  for (const key of CONTEXT_WINDOW_KEYS) {
    const value = entry[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return undefined;
}

/** 解析上游条目中的推理标记（对象形式视为支持） */
function pickReasoning(entry: Record<string, unknown>): boolean | undefined {
  for (const key of ["supports_reasoning", "reasoning", "supports_thinking"]) {
    const value = entry[key];
    if (typeof value === "boolean") return value;
    if (value !== null && typeof value === "object") return true;
  }
  return undefined;
}

/** 解析上游条目中的输入模态（仅当声明包含 image 时返回，其余按纯文本处理） */
function pickInput(entry: Record<string, unknown>): string[] | undefined {
  const architecture = entry.architecture;
  const candidates = [
    entry.input_modalities,
    architecture !== null && typeof architecture === "object"
      ? (architecture as Record<string, unknown>).input_modalities
      : undefined,
    entry.modalities,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.includes("image")) return ["text", "image"];
  }
  return undefined;
}

/** 视觉模型名称特征（上游未报告输入模态时的提示，命中才标记图片） */
const VISION_NAME_PATTERN = /(^|[-_.])(vision|vl|omni|multimodal|4o)(?![a-z])/i;

/** 从 new-api 的 billing_expr 提取上下文分档上界（`len <= N` 中的最大 N） */
function parseContextWindowFromBillingExpr(expr: string): number | undefined {
  let max: number | undefined;
  for (const match of expr.matchAll(/len\s*<=?\s*(\d+)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0 && (max === undefined || value > max)) max = value;
  }
  return max;
}

/**
 * 网关定价端点回退（new-api / one-api 类，匿名可读）：
 * `GET {origin}/api/pricing` 的条目含 `model_name` 与可选 `billing_expr`，
 * 分档表达式的 len 上界即该模型的上下文窗口（如 `len <= 272000 ? ... : ...`）。
 * 非该类网关、无该端点或解析失败时静默返回空表，不影响主流程。
 */
async function fetchPricingContextWindows(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return result;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${origin}/api/pricing`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return result;
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    if (!Array.isArray(body?.data)) return result;
    for (const item of body.data) {
      const name = item.model_name;
      const expr = item.billing_expr;
      if (typeof name !== "string" || !name || typeof expr !== "string") continue;
      const contextWindow = parseContextWindowFromBillingExpr(expr);
      if (contextWindow !== undefined) result.set(name, contextWindow);
    }
  } catch {
    /* 非 new-api 网关或网络异常：静默跳过 */
  } finally {
    clearTimeout(timer);
  }
  return result;
}

export function readModelsFile(file: string): ModelsFile {
  if (!existsSync(file)) return { providers: {} };
  const raw = JSON.parse(readFileSync(file, "utf8")) as ModelsFile;
  if (!raw || typeof raw !== "object" || !raw.providers || typeof raw.providers !== "object") {
    throw new Error("models.json 结构损坏：缺少 providers 对象");
  }
  return raw;
}

export function writeModelsFile(file: string, data: ModelsFile): void {
  writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

export function readAuthFile(file: string): AuthFile {
  if (!existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, "utf8")) as AuthFile;
  return raw && typeof raw === "object" ? raw : {};
}

export function writeAuthFile(file: string, data: AuthFile): void {
  writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

/**
 * 探测上游模型列表（OpenAI 兼容 GET {baseUrl}/models，仅探测不落盘）。
 * apiKey 使用调用方传入的明文（添加表单中填写），失败由上层转为友好错误。
 */
export async function fetchUpstreamModels(baseUrl: string, apiKey: string, timeoutMs = 10000): Promise<UpstreamModel[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`上游返回 HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const list = Array.isArray(body?.data) ? body.data : [];
    const models: UpstreamModel[] = list
      .filter((m) => typeof m?.id === "string" && m.id)
      .map((m) => {
        const contextWindow = pickContextWindow(m);
        const reasoning = pickReasoning(m);
        const input = pickInput(m);
        return {
          id: String(m.id),
          ...(typeof m.display_name === "string" && m.display_name ? { name: m.display_name } : {}),
          ...(typeof m.name === "string" && !m.display_name && m.name !== m.id ? { name: m.name } : {}),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(reasoning !== undefined ? { reasoning } : {}),
          ...(input !== undefined ? { input } : {}),
        };
      });

    // 能力回退：部分网关（如 new-api）的 /models 只有 id，但同源 /api/pricing
    // 的分档定价可推出上下文窗口；仅在上游未报告时补齐。
    if (models.some((m) => m.contextWindow === undefined)) {
      const contexts = await fetchPricingContextWindows(baseUrl, apiKey, timeoutMs);
      for (const m of models) {
        if (m.contextWindow !== undefined) continue;
        const contextWindow = contexts.get(m.id);
        if (contextWindow !== undefined) m.contextWindow = contextWindow;
      }
    }
    // 内置系列档案兜底：上游与定价都没给出的字段，按模型 id 匹配常用系列自动填写
    // （优先级：上游自报 > 定价分档 > 内置档案；仍未命中则由运行时用全局默认补齐）
    for (const m of models) {
      const profile = matchModelProfile(m.id);
      if (!profile) continue;
      if (m.contextWindow === undefined && profile.contextWindow !== undefined) {
        m.contextWindow = profile.contextWindow;
      }
      if (m.reasoning === undefined && profile.reasoning !== undefined) {
        m.reasoning = profile.reasoning;
      }
      if (m.input === undefined && profile.input !== undefined) {
        m.input = [...profile.input];
      }
      if (m.thinkingLevelMap === undefined && profile.thinkingLevelMap !== undefined) {
        m.thinkingLevelMap = { ...profile.thinkingLevelMap };
      }
    }
    // 输入模态提示：上游未报告时按模型名识别常见视觉模型（探测列表可见，导入前可核对）
    for (const m of models) {
      if (m.input === undefined && VISION_NAME_PATTERN.test(m.id)) m.input = ["text", "image"];
    }
    return models;
  } finally {
    clearTimeout(timer);
  }
}
