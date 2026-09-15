/**
 * 应用级设置（workspace/settings.json，我们的文件而非 Pi 的 settings）。
 *
 * 存放跨会话生效的默认值：默认模型与上下文压缩阈值。
 * Pi 的 SettingsManager 在每个会话内以 inMemory 形式接收这里的压缩配置，
 * 不写 ~/.pi 或项目 .pi 下的 settings.json，避免多会话互相干扰。
 *
 * 压缩阈值以「模型上下文窗口百分比」表达（Phase 1.95 起），
 * 由 piAdapter 在会话激活时按当前模型 contextWindow 换算为绝对 token。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ModelRef } from "./agent/session.js";

/** 上下文压缩配置（百分比语义；SDK 侧仍接收换算后的绝对 token） */
export interface CompactionSettings {
  /** 是否启用自动压缩（关闭后仅可手动压缩） */
  enabled: boolean;
  /** 预留窗口百分比：上下文用量超过 contextWindow × (1 - reserve%) 时触发 */
  reservePercent: number;
  /** 压缩时保留最近对话的窗口百分比 */
  keepPercent: number;
}

export interface MapSettings {
  /** 默认底图：天地图矢量 / 天地图影像 / 无底图；未配置密钥时前端显示非阻塞提示并保持矢量图层可用 */
  basemap: "tianditu_vec" | "tianditu_img" | "none";
  /** 天地图注记图层（矢量 cva_w / 影像 cia_w）；缺省视为开启 */
  annotations?: boolean;
  /** 天地图服务密钥，仅保存在本机 workspace/settings.json */
  tiandituToken?: string;
}

export interface AppSettings {
  /** 新会话默认模型（未设置时取首提供商首模型） */
  defaultModel?: ModelRef;
  compaction: CompactionSettings;
  /** 已禁用的全局技能名（会话加载技能时过滤；键为 SKILL.md frontmatter 的 name） */
  disabledSkills?: string[];
  /**
   * 全局自定义指令：追加在内置系统提示词之后（角色设定 / 协作规则 / 记忆规则）。
   * 新建或重新恢复的会话生效；仅空白视为未设置。
   */
  customInstructions?: string;
  /** WebGIS 底图设置；密钥不写入项目 .latio、models.json 或 auth.json。 */
  map: MapSettings;
}

/** 默认值换算到 168k 窗口 ≈ reserve 16800 / keep 20160，与旧绝对值默认接近 */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reservePercent: 10,
  keepPercent: 12,
};

export const DEFAULT_MAP_SETTINGS: MapSettings = {
  basemap: "tianditu_vec",
  annotations: true,
};

const PERCENT_BOUNDS = { min: 1, max: 50 };

/** 全局自定义指令长度上限（字符，防误粘贴超大文本） */
const CUSTOM_INSTRUCTIONS_MAX_CHARS = 200_000;

/** 百分比 → 绝对 token（夹在 [floor, ceiling] 内；contextWindow 无效时按 256000 兜底） */
export function percentToTokens(percent: number, contextWindow: number, floor: number, ceiling: number): number {
  const window = contextWindow > 0 ? contextWindow : 256000;
  const raw = Math.round((window * percent) / 100);
  return Math.min(ceiling, Math.max(floor, raw));
}

function sanitizeCompaction(raw: unknown): CompactionSettings {
  const result = { ...DEFAULT_COMPACTION_SETTINGS };
  if (!raw || typeof raw !== "object") return result;
  const input = raw as Record<string, unknown>;
  if (typeof input.enabled === "boolean") result.enabled = input.enabled;
  for (const key of ["reservePercent", "keepPercent"] as const) {
    const value = Number(input[key]);
    if (Number.isFinite(value)) {
      result[key] = Math.min(PERCENT_BOUNDS.max, Math.max(PERCENT_BOUNDS.min, Math.round(value)));
    }
  }
  return result;
}

/** 归一化任意输入为合法 AppSettings（损坏/缺字段时用默认值兜底） */
export function sanitizeSettings(raw: unknown): AppSettings {
  const result: AppSettings = {
    compaction: { ...DEFAULT_COMPACTION_SETTINGS },
    map: { ...DEFAULT_MAP_SETTINGS },
  };
  if (!raw || typeof raw !== "object") return result;
  const input = raw as Record<string, unknown>;
  const model = input.defaultModel as Partial<ModelRef> | undefined;
  if (model && typeof model.providerId === "string" && typeof model.modelId === "string") {
    result.defaultModel = { providerId: model.providerId, modelId: model.modelId };
  }
  if (Array.isArray(input.disabledSkills)) {
    const names = input.disabledSkills.filter((n): n is string => typeof n === "string" && !!n.trim());
    if (names.length) result.disabledSkills = names;
  }
  if (typeof input.customInstructions === "string") {
    const text = input.customInstructions.slice(0, CUSTOM_INSTRUCTIONS_MAX_CHARS);
    // 空白文本视为清空（undefined），否则保留原文（拼接时再 trim）
    if (text.trim()) result.customInstructions = text;
  }
  const map = input.map as Record<string, unknown> | undefined;
  if (map && typeof map === "object") {
    // 旧值 "tianditu"（0.1.3 及以前）归一化为矢量模式
    if (map.basemap === "tianditu") result.map.basemap = "tianditu_vec";
    else if (map.basemap === "tianditu_vec" || map.basemap === "tianditu_img" || map.basemap === "none") {
      result.map.basemap = map.basemap;
    }
    if (typeof map.annotations === "boolean") result.map.annotations = map.annotations;
    if (typeof map.tiandituToken === "string") {
      const token = map.tiandituToken.trim().slice(0, 512);
      if (token) result.map.tiandituToken = token;
    }
  }
  result.compaction = sanitizeCompaction(input.compaction);
  return result;
}

/** 应用设置的加载/保存（workspace/settings.json；损坏时回退默认值） */
export class SettingsStore {
  private settings: AppSettings;
  private readonly file: string;

  constructor(workspaceDir: string) {
    this.file = resolve(workspaceDir, "settings.json");
    let loaded: unknown = null;
    try {
      if (existsSync(this.file)) loaded = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (err) {
      console.warn(`[settings] settings.json 解析失败，使用默认设置: ${(err as Error).message}`);
    }
    this.settings = sanitizeSettings(loaded);
  }

  get(): AppSettings {
    return {
      ...this.settings,
      compaction: { ...this.settings.compaction },
    };
  }

  update(raw: unknown): AppSettings {
    // 部分更新：只覆盖请求中出现的字段
    const incoming = sanitizeSettings({ ...this.settings, ...(raw as object), compaction: (raw as { compaction?: unknown })?.compaction ?? this.settings.compaction });
    this.settings = incoming;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.settings, null, 2), "utf8");
    return this.get();
  }
}
