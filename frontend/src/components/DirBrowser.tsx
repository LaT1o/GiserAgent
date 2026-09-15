/**
 * 目录浏览弹窗（服务端 GET /api/fs/dirs 逐级浏览）。
 * 浏览器拿不到绝对路径，目录选择走服务端：从盘符开始逐级进入。
 */

import { useEffect, useState } from "react";
import { fetchDirs } from "../api/client";
import type { DirEntry } from "../types";

interface Props {
  /** 初始目录（null 从盘符列表开始） */
  initialPath: string | null;
  onCancel: () => void;
  /** 选中某目录确认 */
  onConfirm: (path: string) => void;
}

export default function DirBrowser({ initialPath, onCancel, onConfirm }: Props) {
  const [current, setCurrent] = useState<string | null>(initialPath);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchDirs(current ?? undefined)
      .then((r) => {
        if (!cancelled) setEntries(r.entries);
      })
      .catch((err) => {
        if (!cancelled) {
          setEntries([]);
          setError((err as Error).message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [current]);

  // 当前目录的父级（从加载结果推断，盘符层无可返回项）
  const parentOfCurrent = entries[0]?.parent ?? null;
  const canGoUp = current !== null;

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog dir-browser" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">选择目录</div>
        <div className="dir-browser-path" title={current ?? ""}>
          {current ?? "（选择磁盘驱动器）"}
        </div>
        <div className="dir-browser-list">
          {loading && <div className="dir-browser-empty">加载中…</div>}
          {error && <div className="dir-browser-empty dir-browser-error">{error}</div>}
          {!loading && !error && canGoUp && (
            <button className="dir-browser-item dir-browser-up" onClick={() => setCurrent(parentOfCurrent)}>
              📁 ..
            </button>
          )}
          {!loading &&
            !error &&
            entries.map((e) => (
              <button
                key={e.path}
                className="dir-browser-item"
                title={e.path}
                onClick={() => setCurrent(e.path)}
              >
                📁 {e.name}
              </button>
            ))}
          {!loading && !error && !entries.length && canGoUp && (
            <div className="dir-browser-empty">（无子目录）</div>
          )}
        </div>
        <div className="dialog-actions">
          <button className="dialog-btn-secondary" onClick={onCancel}>
            取消
          </button>
          <button
            className="dialog-btn-primary"
            disabled={!current}
            title={current ?? "请先进入一个目录"}
            onClick={() => current && onConfirm(current)}
          >
            选择此目录
          </button>
        </div>
      </div>
    </div>
  );
}
