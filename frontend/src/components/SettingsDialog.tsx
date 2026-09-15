/**
 * 应用设置弹窗（侧栏 ⚙ 触发），左侧垂直标签 + 右侧内容：
 * 通用（默认模型 + 上下文压缩百分比）｜全局指令（自定义 agent 提示词/记忆规则）｜
 * 模型提供商（增删改 + 模型导入）｜技能（全局技能管理）｜回收站（软删除会话恢复/彻底删除）。
 * 通用与全局指令页显式保存写 workspace/settings.json；提供商、技能与回收站操作即时生效。
 */

import { useEffect, useMemo, useState } from "react";
import type { AppSettings, AvailableModel, CompactionSettings, SessionInfo } from "../types";
import ProviderManager from "./ProviderManager";
import SkillsManager from "./SkillsManager";
import TrashPanel from "./TrashPanel";

interface Props {
  settings: AppSettings;
  models: AvailableModel[];
  trashSessions: SessionInfo[];
  onClose: () => void;
  /** 保存（部分字段）；失败时抛出由调用方展示错误 */
  onSave: (next: Partial<AppSettings>) => Promise<void>;
  /** 模型列表刷新（provider 变更后调用） */
  onModelsChanged: () => void;
  onRestoreSession: (id: string) => void;
  onPurgeSession: (id: string) => void;
  /** 清空回收站（彻底删除全部） */
  onClearTrash: () => void;
  onRefreshTrash: () => void;
  onError: (message: string) => void;
}

/** 按 provider 分组（optgroup 用） */
function groupModels(models: AvailableModel[]): Map<string, AvailableModel[]> {
  const groups = new Map<string, AvailableModel[]>();
  for (const m of models) {
    const list = groups.get(m.providerId) ?? [];
    list.push(m);
    groups.set(m.providerId, list);
  }
  return groups;
}

type Tab = "general" | "instructions" | "providers" | "skills" | "map" | "trash";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "general", label: "通用" },
  { key: "instructions", label: "全局指令" },
  { key: "providers", label: "模型提供商" },
  { key: "skills", label: "技能" },
  { key: "map", label: "地图" },
  { key: "trash", label: "回收站" },
];

export default function SettingsDialog({
  settings,
  models,
  trashSessions,
  onClose,
  onSave,
  onModelsChanged,
  onRestoreSession,
  onPurgeSession,
  onClearTrash,
  onRefreshTrash,
  onError,
}: Props) {
  const [tab, setTab] = useState<Tab>("general");
  const [defaultModelKey, setDefaultModelKey] = useState(() => {
    const m = settings.defaultModel;
    return m ? `${m.providerId}/${m.modelId}` : "";
  });
  const [compaction, setCompaction] = useState<CompactionSettings>({
    ...settings.compaction,
  });
  /** 全局自定义指令（追加在内置系统提示词之后；保存后 settings prop 更新使 dirty 归零） */
  const [instructions, setInstructions] = useState(settings.customInstructions ?? "");
  const [instructionsSaving, setInstructionsSaving] = useState(false);
  const instructionsDirty = instructions !== (settings.customInstructions ?? "");
  const [saving, setSaving] = useState(false);
  const [mapDraft, setMapDraft] = useState(() => ({ ...settings.map }));
  const mapDirty =
    mapDraft.basemap !== settings.map.basemap ||
    (mapDraft.tiandituToken ?? "") !== (settings.map.tiandituToken ?? "");
  const modelGroups = useMemo(() => groupModels(models), [models]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const chosen = models.find((m) => `${m.providerId}/${m.modelId}` === defaultModelKey);
      await onSave({
        ...(chosen ? { defaultModel: { providerId: chosen.providerId, modelId: chosen.modelId } } : {}),
        compaction,
      });
      onClose();
    } catch {
      // 错误由调用方全局提示
    } finally {
      setSaving(false);
    }
  };

  const handleSaveMap = async () => {
    setSaving(true);
    try {
      await onSave({ map: mapDraft });
    } catch {
      /* 错误由调用方全局提示 */
    } finally {
      setSaving(false);
    }
  };

  const handleSaveInstructions = async () => {
    setInstructionsSaving(true);
    try {
      await onSave({ customInstructions: instructions });
      // 成功后 settings prop 更新，dirty 归零、按钮回灰；失败由调用方全局提示
    } catch {
      /* 错误由调用方全局提示 */
    } finally {
      setInstructionsSaving(false);
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">应用设置</div>
        <nav className="settings-nav" aria-label="设置分类">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`settings-nav-item ${tab === t.key ? "active" : ""}`}
              aria-current={tab === t.key ? "page" : undefined}
              onClick={() => setTab(t.key)}
            >
              <span>{t.label}</span>
              {t.key === "trash" && trashSessions.length > 0 && (
                <span className="settings-nav-count">{trashSessions.length}</span>
              )}
            </button>
          ))}
        </nav>

        {tab === "general" && (
          <div className="settings-content">
            <div className="dialog-field">
              <label>默认模型</label>
              <select
                value={defaultModelKey}
                onChange={(e) => setDefaultModelKey(e.target.value)}
              >
                <option value="">（首提供商首模型）</option>
                {[...modelGroups.entries()].map(([providerId, group]) => (
                  <optgroup key={providerId} label={providerId}>
                    {group.map((m) => (
                      <option key={`${m.providerId}/${m.modelId}`} value={`${m.providerId}/${m.modelId}`}>
                        {m.name}
                        {m.input.includes("image") ? " 📷" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <div className="dialog-hint">新创建的会话将使用此模型；未设置时取第一个提供商的第一个模型。</div>
            </div>

            <div className="dialog-field">
              <label className="dialog-checkbox">
                <input
                  type="checkbox"
                  checked={compaction.enabled}
                  onChange={(e) => setCompaction((c) => ({ ...c, enabled: e.target.checked }))}
                />
                启用自动压缩
              </label>
              <div className="dialog-hint">
                占用超过「模型上下文窗口 × (1 − 预留%)」时自动让模型总结历史；关闭后仅可手动压缩。
              </div>
            </div>

            <div className="dialog-field compaction-percent">
              <label>预留窗口（reservePercent）</label>
              <div className="percent-row">
                <input
                  type="range"
                  min={1}
                  max={50}
                  step={1}
                  value={compaction.reservePercent}
                  onChange={(e) => setCompaction((c) => ({ ...c, reservePercent: Number(e.target.value) || 1 }))}
                />
                <input
                  type="number"
                  min={1}
                  max={50}
                  step={1}
                  value={compaction.reservePercent}
                  onChange={(e) =>
                    setCompaction((c) => ({
                      ...c,
                      reservePercent: Math.min(50, Math.max(1, Math.round(Number(e.target.value) || 1))),
                    }))
                  }
                />
                <span className="percent-sign">%</span>
              </div>
              <div className="dialog-hint">触发阈值 = 窗口 − 窗口 × 此百分比（默认 10%）。</div>
            </div>

            <div className="dialog-field compaction-percent">
              <label>保留近期（keepPercent）</label>
              <div className="percent-row">
                <input
                  type="range"
                  min={1}
                  max={50}
                  step={1}
                  value={compaction.keepPercent}
                  onChange={(e) => setCompaction((c) => ({ ...c, keepPercent: Number(e.target.value) || 1 }))}
                />
                <input
                  type="number"
                  min={1}
                  max={50}
                  step={1}
                  value={compaction.keepPercent}
                  onChange={(e) =>
                    setCompaction((c) => ({
                      ...c,
                      keepPercent: Math.min(50, Math.max(1, Math.round(Number(e.target.value) || 1))),
                    }))
                  }
                />
                <span className="percent-sign">%</span>
              </div>
              <div className="dialog-hint">压缩时保留最近对话的窗口百分比（默认 12%）。</div>
            </div>

            <div className="dialog-actions">
              <button className="dialog-btn-secondary" onClick={onClose}>
                取消
              </button>
              <button className="dialog-btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        )}

        {tab === "instructions" && (
          <div className="dialog-field instructions-field settings-content">
            <label>全局自定义指令</label>
            <textarea
              className="instructions-editor"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={
                "例如：\n- 始终用简体中文回答\n" +
                "- 空间分析优先使用 opengis 工具，先说明数据来源与坐标系\n" +
                "- 每次结论末尾给出下一步建议"
              }
              spellCheck={false}
            />
            <div className="dialog-hint">
              追加在内置系统提示词之后，可放全局角色设定、协作规则或长期记忆（记忆规则）；内置的工具指引保持不变。
              新建或重新打开的会话立即生效，已打开的会话在重启应用后生效；留空则不追加。
            </div>
            <div className="dialog-actions">
              <button
                className="dialog-btn-secondary"
                onClick={() => setInstructions("")}
                disabled={!instructions || instructionsSaving}
              >
                清空
              </button>
              <button
                className="dialog-btn-primary"
                onClick={handleSaveInstructions}
                disabled={!instructionsDirty || instructionsSaving}
              >
                {instructionsSaving ? "保存中…" : "保存"}
              </button>
            </div>
            <details className="prompt-layers">
              <summary>提示词与指令层级说明</summary>
              <div className="prompt-layers-body">
                <p>每次会话的完整提示词由以下层级依次叠加：</p>
                <ol>
                  <li>
                    <strong>内置系统提示词</strong>（随应用更新，只读）：Agent 的基础身份、工具使用规范与安全边界。
                  </li>
                  <li>
                    <strong>全局自定义指令</strong>（本页）：追加在内置系统提示词之后，跨所有会话生效。
                  </li>
                  <li>
                    <strong>技能</strong>（「技能」页管理）：按需调用的流程知识包，模型遇到匹配任务时自动加载或由
                    <code>/skill:</code> 触发，不占用常规上下文。
                  </li>
                  <li>
                    <strong>prompt 模板</strong>（<code>/review</code> 等 slash 命令）：发送时展开为一条用户消息，不进入系统提示词。
                  </li>
                </ol>
                <p>
                  另外，Agent 运行时（pi）原生的 <code>AGENTS.md</code>（项目上下文文件）与 <code>SYSTEM.md</code>
                  （整段替换系统提示词）机制在本应用中已关闭：界面化的「全局指令」即等价于其追加通道（APPEND_SYSTEM.md），
                  避免与设置项形成两套并存的全局提示词来源。
                </p>
              </div>
            </details>
          </div>
        )}

        {tab === "providers" && (
          <div className="settings-content">
            <ProviderManager models={models} onChanged={onModelsChanged} onError={onError} />
          </div>
        )}

        {tab === "skills" && (
          <div className="settings-content">
            <SkillsManager onError={onError} />
          </div>
        )}

        {tab === "map" && (
          <div className="settings-content">
            <div className="dialog-field">
              <label>底图</label>
              <select
                value={mapDraft.basemap}
                onChange={(e) =>
                  setMapDraft((draft) => ({ ...draft, basemap: e.target.value as "tianditu" | "none" }))
                }
              >
                <option value="tianditu">天地图（默认）</option>
                <option value="none">无底图（纯矢量工作区）</option>
              </select>
              <div className="dialog-hint">
                天地图瓦片为 EPSG:3857 网络服务；切换底图后地图立即刷新，矢量图层仍按各自坐标系转换显示。
              </div>
            </div>

            <div className="dialog-field">
              <label>天地图密钥（tk）</label>
              <input
                type="password"
                value={mapDraft.tiandituToken ?? ""}
                autoComplete="off"
                spellCheck={false}
                placeholder="在天地图官网申请的服务密钥"
                onChange={(e) => setMapDraft((draft) => ({ ...draft, tiandituToken: e.target.value }))}
              />
              <div className="dialog-hint">
                仅保存在本机 workspace/settings.json，用于地图瓦片请求；不会写入项目 .latio、models.json 或 auth.json。
                未配置时地图保留矢量图层并提示缺少密钥。
              </div>
            </div>

            <div className="dialog-actions">
              <button
                className="dialog-btn-secondary"
                onClick={() => setMapDraft({ ...settings.map, tiandituToken: "" })}
                disabled={!mapDraft.tiandituToken}
              >
                清除密钥
              </button>
              <button className="dialog-btn-primary" onClick={handleSaveMap} disabled={!mapDirty || saving}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        )}

        {tab === "trash" && (
          <div className="settings-content">
            <TrashPanel
              trashSessions={trashSessions}
              onRestore={onRestoreSession}
              onPurge={onPurgeSession}
              onClearTrash={onClearTrash}
              onRefresh={onRefreshTrash}
            />
          </div>
        )}
      </div>
    </div>
  );
}
