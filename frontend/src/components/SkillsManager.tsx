/**
 * 技能管理（设置弹窗「技能」页）：
 * 按来源分组（应用级 server/.pi/skills / 用户级 ~/.agents/skills），
 * 每项支持启用/禁用开关（会话技能加载过滤）与删除；新增技能 = 放入对应目录。
 */

import { useEffect, useMemo, useState } from "react";
import { deleteGlobalSkill, fetchGlobalSkills, setSkillDisabled } from "../api/client";
import type { GlobalSkillInfo } from "../types";

const SCOPE_GROUPS: Array<{ scope: GlobalSkillInfo["scope"]; label: string; dir: string }> = [
  { scope: "app", label: "应用级", dir: "server/.pi/skills" },
  { scope: "user", label: "用户级", dir: "~/.agents/skills" },
];

export default function SkillsManager({ onError }: { onError: (message: string) => void }) {
  const [skills, setSkills] = useState<GlobalSkillInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    fetchGlobalSkills()
      .then((r) => setSkills(r.skills))
      .catch((err) => onError((err as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  const byScope = useMemo(() => {
    return SCOPE_GROUPS.map((g) => ({ ...g, items: skills.filter((s) => s.scope === g.scope) }));
  }, [skills]);

  const handleToggle = async (skill: GlobalSkillInfo) => {
    // 乐观更新，失败回弹并整体刷新
    setSkills((prev) =>
      prev.map((s) => (s.path === skill.path ? { ...s, enabled: !s.enabled } : s))
    );
    try {
      await setSkillDisabled(skill.name, skill.enabled);
    } catch (err) {
      onError((err as Error).message);
      refresh();
    }
  };

  const handleDelete = async (skill: GlobalSkillInfo) => {
    if (!window.confirm(`删除技能「${skill.name}」？目录内文件将一并删除：\n${skill.path}`)) return;
    try {
      await deleteGlobalSkill(skill.path);
      refresh();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <div className="dialog-field skills-manager">
      <label>已安装技能</label>
      <div className="skills-list">
        {loading && <div className="skills-empty">加载中…</div>}
        {!loading && !skills.length && <div className="skills-empty">（暂无技能）</div>}
        {byScope.map(
          (group) =>
            !!group.items.length && (
              <div key={group.scope} className="skill-group">
                <div className="skill-group-label">
                  {group.label}（{group.dir}）
                </div>
                {group.items.map((s) => (
                  <div key={s.path} className={`skill-item ${s.enabled ? "" : "off"}`}>
                    <button
                      type="button"
                      className={`skill-switch ${s.enabled ? "on" : ""}`}
                      role="switch"
                      aria-checked={s.enabled}
                      title={s.enabled ? "已启用（会话可加载）" : "已禁用（会话不加载）"}
                      onClick={() => void handleToggle(s)}
                    />
                    <div className="skill-main">
                      <span className="skill-name">{s.name}</span>
                      <span className="skill-desc" title={s.description}>
                        {s.description || "（无描述）"}
                      </span>
                      <span className="skill-scope" title={s.path}>
                        {s.enabled ? "已启用" : "已禁用"}
                      </span>
                    </div>
                    <button
                      className="session-action-btn session-action-danger"
                      title={`删除技能（移除目录 ${s.path}）`}
                      onClick={() => void handleDelete(s)}
                    >
                      🗑
                    </button>
                  </div>
                ))}
              </div>
            )
        )}
      </div>
      <div className="dialog-hint">
        开关控制技能是否进入会话（禁用即刻对新会话/切换后恢复的会话生效）；
        新增技能：将 <code>&lt;技能名&gt;/SKILL.md</code> 放入上述任一目录。
        项目级技能（项目 .pi/skills）随项目自动加载，不在此管理。
      </div>
    </div>
  );
}
