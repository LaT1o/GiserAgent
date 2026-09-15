/**
 * 新建项目弹窗：名称 + 路径（手输或 DirBrowser 浏览选择）。
 * 提交调 POST /api/projects（服务端校验路径存在）。
 */

import { useEffect, useState } from "react";
import { createProject } from "../api/client";
import type { Project } from "../types";
import DirBrowser from "./DirBrowser";

interface Props {
  onCancel: () => void;
  onCreated: (project: Project) => void;
  /** 失败提示（由调用方承接全局错误样式） */
  onError: (message: string) => void;
}

export default function ProjectDialog({ onCancel, onCreated, onError }: Props) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [pathHint, setPathHint] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !browsing) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, browsing]);

  /** 选择目录：桌面环境走系统原生文件夹选择框，浏览器走 File System Access，均不可用手输兜底 */
  const browse = async () => {
    if (window.giserDesktop?.pickDirectory) {
      const chosen = await window.giserDesktop.pickDirectory();
      if (chosen) setPath(chosen);
      return;
    }
    if (typeof window.showDirectoryPicker === "function") {
      try {
        const dir = await window.showDirectoryPicker();
        // Chromium 目录句柄无绝对路径：name 仅末段，提示用户确认完整路径
        if (dir) {
          setPath((prev) => (prev.trim() ? prev : dir.name));
          setPathHint("浏览器安全限制无法取得所选文件夹的完整路径，请补全为绝对路径");
        }
      } catch {
        /* 用户取消 */
      }
      return;
    }
    setBrowsing(true);
  };

  const submit = async () => {
    if (!path.trim() || creating) return;
    setCreating(true);
    try {
      const { project } = await createProject(name.trim(), path.trim());
      onCreated(project);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  if (browsing) {
    return (
      <DirBrowser
        initialPath={null}
        onCancel={() => setBrowsing(false)}
        onConfirm={(chosen) => {
          setPath(chosen);
          setBrowsing(false);
        }}
      />
    );
  }

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">新建项目</div>
        <div className="dialog-field">
          <label>项目名称</label>
          <input
            value={name}
            autoFocus
            placeholder="（留空取路径末段）"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="dialog-field">
          <label>项目路径（绝对路径，须存在）</label>
          <div className="project-path-row">
            <input
              value={path}
              placeholder="C:\\path\\to\\project"
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
            <button className="dialog-btn-secondary" onClick={() => void browse()}>
              浏览…
            </button>
          </div>
          <div className="dialog-hint">
            {pathHint ?? "点击「浏览…」从系统文件夹选择框选取；绑定后新建会话在项目目录工作，侧栏按项目分组。"}
          </div>
        </div>
        <div className="dialog-actions">
          <button className="dialog-btn-secondary" onClick={onCancel}>
            取消
          </button>
          <button className="dialog-btn-primary" onClick={submit} disabled={!path.trim() || creating}>
            {creating ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
