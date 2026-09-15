/**
 * 上下文详情弹窗（顶栏占用条点击打开）：
 * 真实总量（LLM 上报）+ 成分条形分解（本地估算）+ 最近一轮账单。
 */

import { useEffect, useState } from "react";
import { fetchContext } from "../api/client";
import type { SessionContextInfo } from "../types";

interface Props {
  sessionId: string;
  onClose: () => void;
}

const fmt = (n: number): string => n.toLocaleString();

/** 成分条目定义（label → breakdown key），分类参考 DeepSeek Harness 的组装理念 */
const BREAKDOWN_ROWS: Array<{ key: keyof SessionContextInfo["breakdown"]; label: string }> = [
  { key: "messages", label: "消息" },
  { key: "tools", label: "系统工具" },
  { key: "systemPrompt", label: "系统提示词" },
  { key: "skills", label: "技能" },
  { key: "other", label: "其他（图片等）" },
];

export default function ContextDetail({ sessionId, onClose }: Props) {
  const [context, setContext] = useState<SessionContextInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchContext(sessionId)
      .then((r) => !cancelled && setContext(r.context))
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const breakdownTotal = context
    ? BREAKDOWN_ROWS.reduce((sum, r) => sum + context.breakdown[r.key], 0)
    : 0;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog context-detail" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">上下文占用</div>
        {error && <div className="dir-browser-error">{error}</div>}
        {!context && !error && <div className="dir-browser-empty">加载中…</div>}
        {context && (
          <>
            <div className="context-total">
              <div className="context-total-label">
                真实占用（最近一轮 LLM 上报）
                {context.total.tokens === null && (
                  <span className="context-unknown">（压缩后待下一轮响应刷新）</span>
                )}
              </div>
              <div className="context-total-value">
                {context.total.tokens === null
                  ? "—"
                  : `${fmt(context.total.tokens)} / ${fmt(context.total.contextWindow)} tokens`}
                {context.total.percent !== null && (
                  <span className="context-percent">（{context.total.percent.toFixed(1)}%）</span>
                )}
              </div>
              <div className="context-bar">
                <div
                  className={`context-bar-fill ${
                    (context.total.percent ?? 0) >= 90 ? "danger" : (context.total.percent ?? 0) >= 70 ? "warn" : ""
                  }`}
                  style={{ width: `${Math.min(100, Math.max(0, context.total.percent ?? 0))}%` }}
                />
              </div>
            </div>

            <div className="context-section-title">成分分解（本地估算，与真实值存在偏差）</div>
            <div className="context-breakdown">
              {BREAKDOWN_ROWS.map((row) => {
                const value = context.breakdown[row.key];
                const width = breakdownTotal > 0 ? (value / breakdownTotal) * 100 : 0;
                return (
                  <div key={row.key} className="context-breakdown-row">
                    <span className="context-breakdown-label">{row.label}</span>
                    <div className="context-breakdown-bar">
                      <div className="context-breakdown-fill" style={{ width: `${width}%` }} />
                    </div>
                    <span className="context-breakdown-value">{fmt(value)}</span>
                  </div>
                );
              })}
              <div className="context-breakdown-sum">估算合计 {fmt(breakdownTotal)} tokens</div>
            </div>

            {context.lastUsage && (
              <>
                <div className="context-section-title">最近一轮账单</div>
                <div className="context-bill">
                  <span>输入 {fmt(context.lastUsage.input)}</span>
                  <span>输出 {fmt(context.lastUsage.output)}</span>
                  {typeof context.lastUsage.reasoning === "number" && (
                    <span>思考 {fmt(context.lastUsage.reasoning)}</span>
                  )}
                  {!!context.lastUsage.cacheRead && (
                    <span>缓存读 {fmt(context.lastUsage.cacheRead)}</span>
                  )}
                  {!!context.lastUsage.cacheWrite && (
                    <span>缓存写 {fmt(context.lastUsage.cacheWrite)}</span>
                  )}
                  <span>合计 {fmt(context.lastUsage.totalTokens)}</span>
                </div>
              </>
            )}
          </>
        )}
        <div className="dialog-actions">
          <button className="dialog-btn-primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
