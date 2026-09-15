/**
 * 模型提供商管理（设置弹窗「模型提供商」页）：
 * 列表 + 添加/编辑表单（ID/名称/BaseURL/API Key）+ 模型管理（已导入列表/删除/上游探测勾选导入）。
 * 密钥只写 server/.pi/auth.json（不入库）；models.json 不含密钥。
 */

import { useEffect, useRef, useState } from "react";
import {
  addProvider,
  fetchProviders,
  fetchUpstreamModels,
  importModels,
  removeModels,
  removeProvider,
  updateProvider,
} from "../api/client";
import type { AvailableModel, ImportModelInput, ProviderSummary, UpstreamModel } from "../types";

interface Props {
  /** 全部可用模型（模型管理列表按 providerId 过滤） */
  models: AvailableModel[];
  /** 数据变更后通知调用方刷新模型列表 */
  onChanged: () => void;
  onError: (message: string) => void;
}

type FormMode =
  | { kind: "closed" }
  | { kind: "add" }
  | { kind: "edit"; provider: ProviderSummary };

/** 推理模型的最高思考档位（SDK 中 xhigh/max 需在 thinkingLevelMap 里显式出现才可选） */
type EffortCeiling = "high" | "xhigh" | "max";

/** 从 thinkingLevelMap 推导当前最高档（无扩展键时为 high） */
function highestEffort(map?: Record<string, string | null>): EffortCeiling {
  if (map?.max) return "max";
  if (map?.xhigh) return "xhigh";
  return "high";
}

/**
 * 最高档 → thinkingLevelMap（保留档案给出的其他档位限制，如 DeepSeek 的 minimal/medium:null）。
 * high = 关闭 xhigh/max；xhigh = 只开 xhigh；max = 两档全开。
 */
function effortToMap(
  effort: EffortCeiling,
  base?: Record<string, string | null>
): Record<string, string | null> {
  const map: Record<string, string | null> = { ...base };
  if (effort === "max") {
    map.xhigh = "xhigh";
    map.max = "max";
  } else if (effort === "xhigh") {
    map.xhigh = "xhigh";
    map.max = null;
  } else {
    map.xhigh = null;
    map.max = null;
  }
  return map;
}

/** 上游上下文窗口展示（如 168k） */
function formatUpstreamContext(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/**
 * 探测结果 → 导入入参：透传上游自报/内置档案给出的上下文窗口、模态与思考档位映射。
 * 推理模型没有档位映射时默认写入 xhigh/max（导入即解锁 off..max）；
 * 未报告推理能力则不写字段，由服务端按全局默认（支持思考、全档位）补齐。
 */
function toImportInput(m: UpstreamModel): ImportModelInput {
  return {
    id: m.id,
    ...(m.name ? { name: m.name } : {}),
    ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
    ...(m.input !== undefined ? { input: m.input } : {}),
    ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
    ...(m.thinkingLevelMap !== undefined
      ? { thinkingLevelMap: m.thinkingLevelMap }
      : m.reasoning === true
        ? { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }
        : {}),
  };
}

export default function ProviderManager({ models, onChanged, onError }: Props) {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [form, setForm] = useState<{ idAdd?: string; name: string; baseUrl: string; apiKey: string }>({
    name: "",
    baseUrl: "",
    apiKey: "",
  });
  const [mode, setMode] = useState<FormMode>({ kind: "closed" });
  /** 模型管理中的 provider id */
  const [managingId, setManagingId] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  /** 上游探测结果（勾选状态在 id 集合里） */
  const [upstream, setUpstream] = useState<UpstreamModel[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  /** 上下文窗口输入草稿（key = providerId/modelId；提交后清空，回落到模型实际值） */
  const [ctxDrafts, setCtxDrafts] = useState<Record<string, string>>({});
  /** 停止输入后的自动保存计时器（避免未失焦就切走时草稿被静默丢弃） */
  const ctxCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ctxKey = (providerId: string, modelId: string) => `${providerId}/${modelId}`;

  const clearCtxDraft = (key: string) =>
    setCtxDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

  useEffect(
    () => () => {
      if (ctxCommitTimer.current) clearTimeout(ctxCommitTimer.current);
    },
    []
  );

  /** 合并更新单个模型元数据（importModels 为 upsert 语义，未传字段保持原值） */
  const updateModelMeta = async (
    providerId: string,
    modelId: string,
    patch: { reasoning?: boolean; contextWindow?: number; thinkingLevelMap?: Record<string, string | null> }
  ) => {
    try {
      await importModels(providerId, [{ id: modelId, ...patch }]);
      onChanged();
      refresh();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  /**
   * 提交上下文窗口草稿。非法中间态（过短/非数字）默认保留草稿让用户继续输入，
   * 失焦时以 dropInvalid 丢弃回落到原值；合法且与当前值不同才落盘。
   */
  const commitContextWindow = (
    providerId: string,
    modelId: string,
    current?: number,
    opts?: { dropInvalid?: boolean }
  ) => {
    if (ctxCommitTimer.current) {
      clearTimeout(ctxCommitTimer.current);
      ctxCommitTimer.current = null;
    }
    const key = ctxKey(providerId, modelId);
    const raw = ctxDrafts[key];
    if (raw === undefined) return;
    const value = Math.round(Number(raw));
    if (!Number.isFinite(value) || value < 1000) {
      if (opts?.dropInvalid) clearCtxDraft(key);
      return;
    }
    clearCtxDraft(key);
    if (value === current) return;
    void updateModelMeta(providerId, modelId, { contextWindow: value });
  };

  const refresh = () => {
    fetchProviders()
      .then((r) => setProviders(r.providers))
      .catch(() => {});
  };

  useEffect(refresh, []);

  const resetForm = () => {
    setForm({ name: "", baseUrl: "", apiKey: "" });
    setUpstream(null);
    setChecked(new Set());
    setMode({ kind: "closed" });
  };

  const openAdd = () => {
    setForm({ idAdd: "", name: "", baseUrl: "", apiKey: "" });
    setUpstream(null);
    setChecked(new Set());
    setMode({ kind: "add" });
  };

  const openEdit = (p: ProviderSummary) => {
    setForm({ name: p.name === p.id ? "" : p.name, baseUrl: p.baseUrl, apiKey: "" });
    setUpstream(null);
    setChecked(new Set());
    setMode({ kind: "edit", provider: p });
  };

  /** 探测上游模型列表（表单 baseUrl + key；编辑态 key 留空时用 auth.json 已存密钥探测） */
  const probeUpstream = async () => {
    const p = mode.kind === "edit" ? mode.provider : null;
    const baseUrl = form.baseUrl.trim() || p?.baseUrl || "";
    const key = form.apiKey.trim();
    if (!baseUrl || (!key && !p)) {
      onError("请先填写 Base URL 与 API Key 再获取（编辑态可留空 Key，使用已保存密钥）");
      return;
    }
    setProbing(true);
    try {
      const { models: found } = await fetchUpstreamModels(baseUrl, key || undefined, p?.id);
      setUpstream(found);
      setChecked(new Set(found.map((m) => m.id)));
    } catch (err) {
      onError((err as Error).message);
      setUpstream([]);
    } finally {
      setProbing(false);
    }
  };

  /** 保存（新增走 addProvider；编辑走 updateProvider）；勾选了模型则一并导入 */
  const saveProvider = async () => {
    if (!form.baseUrl.trim() || importing) return;
    setImporting(true);
    try {
      if (mode.kind === "add") {
        const { provider } = await addProvider({
          id: form.idAdd ?? "",
          name: form.name.trim() || undefined,
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey || undefined,
        });
        const selected = upstream?.filter((m) => checked.has(m.id)) ?? [];
        if (selected.length) {
          await importModels(provider.id, selected.map(toImportInput));
        }
      } else if (mode.kind === "edit") {
        await updateProvider(mode.provider.id, {
          ...(form.name.trim() ? { name: form.name.trim() } : {}),
          baseUrl: form.baseUrl.trim(),
          ...(form.apiKey ? { apiKey: form.apiKey } : {}),
        });
        const selected = upstream?.filter((m) => checked.has(m.id)) ?? [];
        if (selected.length) {
          await importModels(mode.provider.id, selected.map(toImportInput));
        }
      }
      onChanged();
      refresh();
      resetForm();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await removeProvider(id);
      onChanged();
      refresh();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const handleRemoveModel = async (providerId: string, modelId: string) => {
    try {
      await removeModels(providerId, [modelId]);
      onChanged();
      refresh();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const toggleChecked = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const managing = managingId ? providers.find((p) => p.id === managingId) : null;
  const providerModels = managingId ? models.filter((m) => m.providerId === managingId) : [];

  return (
    <div className="dialog-field provider-manager">
      <label>模型提供商</label>

      {/* 模型管理面板：单个 provider 的已导入模型 + 上游探测导入 */}
      {managing && (
        <div className="provider-models-panel">
          <div className="provider-models-title">
            模型管理 · {managing.name}
            <button className="dialog-btn-secondary" onClick={() => setManagingId(null)}>
              返回
            </button>
          </div>
          <div className="provider-model-list">
            {providerModels.map((m) => (
              <div key={m.modelId} className="provider-model-item">
                <span className="provider-model-name">
                  {m.name}
                  {m.input.includes("image") && (
                    <span className="model-cap-badge" title="支持图片输入">
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
                        <rect x="2" y="3" width="12" height="10" rx="2" />
                        <circle cx="5.5" cy="6.5" r="1" />
                        <path d="M2.5 12 6.5 8.5l2.5 2 2-1.5 2.5 2.5" />
                      </svg>
                    </span>
                  )}
                  {/* SDK 仅 text/image 参与请求能力判断，其余模态仅作标识展示 */}
                  {m.input
                    .filter((modality) => modality !== "text" && modality !== "image")
                    .map((modality) => (
                      <span key={modality} className="model-cap-badge" title={`支持 ${modality} 输入（仅标识）`}>
                        {modality.slice(0, 1).toUpperCase()}
                      </span>
                    ))}
                </span>
                <span className="provider-model-id">{m.modelId}</span>
                {m.reasoning && (
                  <select
                    className="model-effort-select"
                    title="最高思考档位：原样作为上游 reasoning_effort 发送（上游不认时报错，可调低）；会话内选 off 即关闭思考"
                    value={highestEffort(m.thinkingLevelMap)}
                    onChange={(e) =>
                      void updateModelMeta(managing.id, m.modelId, {
                        thinkingLevelMap: effortToMap(
                          e.target.value as EffortCeiling,
                          m.thinkingLevelMap
                        ),
                      })
                    }
                  >
                    <option value="high">high</option>
                    <option value="xhigh">xhigh</option>
                    <option value="max">max</option>
                  </select>
                )}
                <input
                  className="model-context-input"
                  type="number"
                  min={1000}
                  step={1000}
                  placeholder="上下文窗口"
                  title="上下文窗口（tokens）：用于占用条与压缩阈值换算，留空用默认 256000"
                  value={ctxDrafts[ctxKey(managing.id, m.modelId)] ?? (m.contextWindow ? String(m.contextWindow) : "")}
                  onChange={(e) => {
                    const key = ctxKey(managing.id, m.modelId);
                    setCtxDrafts((prev) => ({ ...prev, [key]: e.target.value }));
                    // 停止输入 800ms 后自动保存：未失焦就切走（换 provider/关弹窗）也不丢改动
                    if (ctxCommitTimer.current) clearTimeout(ctxCommitTimer.current);
                    ctxCommitTimer.current = setTimeout(
                      () => commitContextWindow(managing.id, m.modelId, m.contextWindow),
                      800
                    );
                  }}
                  onBlur={() => commitContextWindow(managing.id, m.modelId, m.contextWindow, { dropInvalid: true })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitContextWindow(managing.id, m.modelId, m.contextWindow, { dropInvalid: true });
                  }}
                />
                <button
                  className="session-action-btn session-action-danger"
                  title="移除该模型"
                  onClick={() => void handleRemoveModel(managing.id, m.modelId)}
                >
                  ✕
                </button>
              </div>
            ))}
            {!providerModels.length && (
              <div className="provider-empty">（该提供商暂无已导入模型，可在编辑表单中探测上游后勾选导入）</div>
            )}
          </div>
          <button className="provider-add-btn" onClick={() => { setManagingId(null); openEdit(managing); }}>
            ＋ 从上游探测并导入模型（编辑 {managing.name}）
          </button>
        </div>
      )}

      {!managing && (
        <>
          <div className="provider-list">
            {providers.map((p) => (
              <div key={p.id} className="provider-item">
                <div className="provider-info">
                  <span className="provider-name">{p.name}</span>
                  <span className="provider-meta">
                    {p.modelCount} 模型 · {p.hasStoredKey ? "密钥已存" : "无密钥"}
                  </span>
                </div>
                <span className="provider-url" title={p.baseUrl}>
                  {p.baseUrl}
                </span>
                <button
                  className="session-action-btn"
                  title="模型管理（列表/删除/上游导入）"
                  onClick={() => setManagingId(p.id)}
                >
                  ⚙
                </button>
                <button
                  className="session-action-btn"
                  title="编辑提供商（名称/BaseURL/密钥）"
                  onClick={() => openEdit(p)}
                >
                  ✎
                </button>
                <button
                  className="session-action-btn session-action-danger"
                  title="删除提供商"
                  onClick={() => void handleRemove(p.id)}
                >
                  ✕
                </button>
              </div>
            ))}
            {!providers.length && <div className="provider-empty">（暂无提供商）</div>}
          </div>

          {mode.kind !== "closed" ? (
            <div className="provider-form">
              {mode.kind === "add" && (
                <input
                  placeholder="ID（如 my-gateway，创建后不可改）"
                  value={form.idAdd ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, idAdd: e.target.value }))}
                />
              )}
              {mode.kind === "edit" && (
                <input value={`ID：${mode.provider.id}（不可改）`} disabled />
              )}
              <div className="provider-form-row">
                <input
                  placeholder="名称（可选）"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
              <input
                placeholder="Base URL（如 https://host/v1）"
                value={form.baseUrl}
                onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
              />
              <input
                placeholder={
                  mode.kind === "edit"
                    ? "API Key（留空保持不变；填写则覆盖 auth.json）"
                    : "API Key（保存到本地 auth.json，不入库）"
                }
                type="password"
                value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              />
              <div className="provider-form-actions">
                <button className="dialog-btn-secondary" onClick={() => void probeUpstream()} disabled={probing}>
                  {probing ? "获取中…" : "获取上游模型"}
                </button>
                <button className="dialog-btn-secondary" onClick={resetForm}>
                  取消
                </button>
                <button
                  className="dialog-btn-primary"
                  onClick={() => void saveProvider()}
                  disabled={!form.baseUrl.trim() || (mode.kind === "add" && !form.idAdd?.trim()) || importing}
                >
                  {importing ? "保存中…" : "保存"}
                </button>
              </div>
              {upstream && (
                <div className="upstream-list">
                  <div className="upstream-title">
                    上游模型（勾选后随保存导入
                    {upstream.length ? "" : "；获取失败可先保存再手动编辑 models.json"}）
                  </div>
                  {upstream.map((m) => (
                    <label key={m.id} className="upstream-item">
                      <input
                        type="checkbox"
                        checked={checked.has(m.id)}
                        onChange={() => toggleChecked(m.id)}
                      />
                      <span className="upstream-name">{m.name ?? m.id}</span>
                      <span className="upstream-id">{m.id}</span>
                      <span className="upstream-caps">
                        {m.contextWindow !== undefined && (
                          <span
                            className="upstream-cap"
                            title={`上游自报上下文窗口 ${m.contextWindow} tokens`}
                          >
                            {formatUpstreamContext(m.contextWindow)}
                          </span>
                        )}
                        {m.reasoning && (
                          <span
                            className="upstream-cap upstream-cap-reasoning"
                            title="上游自报支持推理（导入后默认解锁 off..max 全量思考档位）"
                          >
                            ◆ 推理
                          </span>
                        )}
                        {m.input?.includes("image") && (
                          <span className="upstream-cap" title="上游自报支持图片输入">
                            图片
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button className="provider-add-btn" onClick={openAdd}>
              ＋ 添加提供商
            </button>
          )}
          <div className="dialog-hint">
            OpenAI 兼容网关：填 Base URL 与 Key 后可自动拉取上游模型列表；密钥只存本地 auth.json。
            ⚙ = 模型管理，✎ = 编辑连接信息。上游自报支持推理的模型导入后自动开启思考并解锁
            off..max 全量档位；未识别到能力的模型可在 ⚙ 模型管理中手动调整。
          </div>
        </>
      )}
    </div>
  );
}
