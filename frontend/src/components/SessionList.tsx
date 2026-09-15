import { useEffect, useMemo, useRef, useState, type HTMLAttributes } from "react";
import type { Project, SessionInfo } from "../types";
import { createProject, renameProject } from "../api/client";
import ProjectDialog from "./ProjectDialog";
import RowMenu from "./RowMenu";

interface Props {
  sessions: SessionInfo[];
  projects: Project[];
  activeId: string | null;
  selectedProjectId: string | null;
  onSelect: (id: string) => void;
  onSelectProject: (id: string | null) => void;
  onCreate: (input?: { projectId?: string; projectPath?: string }) => void;
  onProjectCreated: (project: Project) => void;
  onProjectRenamed: (project: Project) => void;
  onDeleteProject: (projectId: string) => void;
  onReorderProjects: (orderedIds: string[]) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onReorderSessions: (orderedIds: string[]) => void;
  onOpenDir: (session: SessionInfo) => void;
  /** 在资源管理器打开项目注册路径 */
  onOpenProjectDir: (project: Project) => void;
  onError: (message: string) => void;
}

const STATUS_LABEL: Record<SessionInfo["status"], string> = {
  starting: "启动中", idle: "空闲", running: "运行中", closed: "已关闭",
};

function displayName(session: SessionInfo): string {
  return session.title?.trim() || "新建会话";
}

function InlineRename({ value, label, onSubmit, onClose }: {
  value: string; label: string; onSubmit: (name: string) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const finished = useRef(false);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const name = draft.trim();
    if (save && name && name !== value) onSubmit(name);
    onClose();
  };
  return (
    <input
      className="session-rename-input"
      aria-label={label}
      value={draft}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          finish(event.key === "Enter");
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

type DragHandlers = Pick<HTMLAttributes<HTMLLIElement>, "onDragStart" | "onDragOver" | "onDrop" | "onDragEnd">;

function SessionItem({ session, active, canDrag, dragClass, dragHandlers, onSelect, onRename, onDelete, onTogglePin, onOpenDir }: {
  session: SessionInfo;
  active: boolean;
  canDrag: boolean;
  dragClass: string;
  dragHandlers: DragHandlers;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onOpenDir: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const name = displayName(session);
  return (
    <li
      className={`session-item ${active ? "active" : ""} ${session.status === "closed" ? "closed" : ""} ${dragClass}`}
      draggable={canDrag && !editing}
      {...dragHandlers}
      onClick={onSelect}
    >
      {editing ? (
        <InlineRename value={name} label="会话名称" onSubmit={onRename} onClose={() => setEditing(false)} />
      ) : (
        <>
          <button type="button" className="session-main" title={name} aria-current={active ? "page" : undefined}>
            <span className={`session-name ${session.mode === "plan" ? "mode-plan" : ""}`}>
              {session.pinned && <span className="session-pin-flag" aria-label="已置顶">📌</span>}
              {name}
            </span>
          </button>
          <div className="session-actions">
            <span className={`status-badge status-${session.status}`}>{STATUS_LABEL[session.status]}</span>
            <RowMenu label={`会话「${name}」的操作`} actions={[
              { label: session.pinned ? "取消置顶" : "置顶", onSelect: onTogglePin },
              { label: "在资源管理器中打开", onSelect: onOpenDir },
              { label: "重命名", onSelect: () => setEditing(true) },
              { label: "移入回收站", danger: true, onSelect: onDelete },
            ]} />
          </div>
        </>
      )}
    </li>
  );
}

interface SessionGroup {
  key: string;
  name: string;
  project?: Project;
  sessions: SessionInfo[];
}

type DragTarget = { kind: "session" | "project"; id: string };

export default function SessionList({
  sessions, projects, activeId, selectedProjectId,
  onSelect, onSelectProject, onCreate, onProjectCreated, onProjectRenamed,
  onDeleteProject, onReorderProjects, onRename, onDelete, onTogglePin,
  onReorderSessions, onOpenDir, onOpenProjectDir, onError,
}: Props) {
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragTarget | null>(null);
  const [drop, setDrop] = useState<(DragTarget & { before: boolean }) | null>(null);
  const activeProjectPath = sessions.find((session) => session.id === activeId)?.projectPath;
  const canDrag = !search.trim();

  useEffect(() => {
    if (!activeId) return;
    setCollapsed((previous) => {
      const next = new Set(previous);
      next.delete(activeProjectPath ?? "");
      return next;
    });
  }, [activeId, activeProjectPath]);

  const groups = useMemo(() => {
    // 项目实体先建组，空项目也可选择、新建会话和重命名。
    const byPath = new Map<string, SessionGroup>(projects.map((project) => [project.path, {
      key: project.path, name: project.name, project, sessions: [],
    }]));
    for (const session of sessions) {
      const key = session.projectPath ?? "";
      let group = byPath.get(key);
      if (!group) {
        const tail = key.replace(/\\/g, "/").split("/").filter(Boolean).pop();
        group = { key, name: tail === "temp" ? "临时会话" : tail ?? "未分组", sessions: [] };
        byPath.set(key, group);
      }
      group.sessions.push(session);
    }
    const registered = projects.map((project) => byPath.get(project.path)!);
    const other = [...byPath.values()].filter((group) => !group.project)
      .sort((a, b) => a.key.localeCompare(b.key));
    const all = [...registered, ...other];
    const query = search.trim().toLowerCase();
    if (!query) return all;
    return all.map((group) => {
      if (`${group.name} ${group.key}`.toLowerCase().includes(query)) return group;
      return { ...group, sessions: group.sessions.filter((session) =>
        displayName(session).toLowerCase().includes(query) || session.id.toLowerCase().startsWith(query)) };
    }).filter((group) => group.sessions.length || `${group.name} ${group.key}`.toLowerCase().includes(query));
  }, [sessions, projects, search]);

  const toggleGroup = (key: string) => setCollapsed((previous) => {
    const next = new Set(previous);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  const clearDrag = () => { setDrag(null); setDrop(null); };

  const newProject = async () => {
    if (creatingProject) return;
    if (!window.giserDesktop?.pickDirectory) {
      setProjectDialogOpen(true);
      return;
    }
    setCreatingProject(true);
    try {
      const chosen = await window.giserDesktop.pickDirectory();
      if (chosen) onProjectCreated((await createProject("", chosen)).project);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setCreatingProject(false);
    }
  };

  const renameGroup = async (project: Project, name: string) => {
    try {
      onProjectRenamed((await renameProject(project.id, name)).project);
    } catch (error) {
      onError((error as Error).message);
    }
  };

  const dropSession = (group: SessionGroup, targetId: string, before: boolean) => {
    if (drag?.kind === "session" && drag.id !== targetId && group.sessions.some((session) => session.id === drag.id)) {
      const moved = group.sessions.find((session) => session.id === drag.id)!;
      const ordered = group.sessions.filter((session) => session.id !== drag.id);
      const index = ordered.findIndex((session) => session.id === targetId);
      ordered.splice(index + (before ? 0 : 1), 0, moved);
      const groupIds = new Set(group.sessions.map((session) => session.id));
      let next = 0;
      onReorderSessions(sessions.map((session) => groupIds.has(session.id) ? ordered[next++].id : session.id));
    }
    clearDrag();
  };

  const dropProject = (targetId: string, before: boolean) => {
    if (drag?.kind === "project" && drag.id !== targetId) {
      const ordered = projects.map((project) => project.id).filter((id) => id !== drag.id);
      const index = ordered.indexOf(targetId);
      ordered.splice(index + (before ? 0 : 1), 0, drag.id);
      onReorderProjects(ordered);
    }
    clearDrag();
  };

  return (
    <div className="session-list" onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrop(null);
    }}>
      <div className="session-create-actions">
        <button type="button" className="new-session"
          title="新建会话（默认临时目录 workspace/temp；在项目内新建请用项目行右侧菜单）"
          onClick={() => onCreate(undefined)}>
          ＋ 新建会话
        </button>
        <button type="button" className="new-project" disabled={creatingProject} onClick={() => void newProject()}>
          {creatingProject ? "正在选择文件夹…" : "＋ 新建项目"}
        </button>
      </div>
      <div className="session-search">
        <input aria-label="搜索会话或项目" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索会话或项目" />
      </div>
      {groups.map((group) => {
        const project = group.project;
        const expanded = !collapsed.has(group.key) || !!search.trim();
        const groupDrop = drop?.kind === "project" && drop.id === project?.id;
        return (
          <div key={group.key || "__ungrouped__"} className="session-group">
            <div className={`session-group-header ${drag?.kind === "project" && drag.id === project?.id ? "dragging" : ""} ${groupDrop ? "drop-target" : ""}`}
              draggable={canDrag && !!project && renamingProjectId !== project.id}
              onDragStart={(event) => {
                if (!project || (event.target as HTMLElement).closest(".row-menu-trigger, input, .session-group-caret")) { event.preventDefault(); return; }
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", project.id);
                setDrag({ kind: "project", id: project.id });
              }}
              onDragOver={(event) => {
                if (drag?.kind !== "project" || !project || drag.id === project.id) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                setDrop({ kind: "project", id: project.id, before: event.clientY < rect.top + rect.height / 2 });
              }}
              onDrop={(event) => {
                if (drag?.kind !== "project" || !project) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                dropProject(project.id, event.clientY < rect.top + rect.height / 2);
              }}
              onClick={() => {
                // 整行点击 = 选中该项目并切换展开/收起（重命名中不响应，避免打断输入框的失焦提交）
                if (renamingProjectId === project?.id) return;
                onSelectProject(project?.id ?? null);
                toggleGroup(group.key);
              }}
              onDragEnd={clearDrag}>
              <span className="session-group-caret" aria-hidden="true">
                {expanded ? "▾" : "▸"}
              </span>
              <span className="session-group-folder" aria-hidden="true">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
                  <path d="M1.5 4a1 1 0 0 1 1-1h3l1.4 1.6h6.6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
                </svg>
              </span>
              {project && renamingProjectId === project.id ? (
                <InlineRename value={project.name} label="项目名称" onSubmit={(name) => void renameGroup(project, name)} onClose={() => setRenamingProjectId(null)} />
              ) : (
                <button type="button" className="session-group-select" title={group.key || "默认临时目录"}
                  aria-pressed={!!project && project.id === selectedProjectId}
                  aria-expanded={expanded}>
                  <span className="session-group-name">{group.name}</span>
                  <span className="session-group-count">{group.sessions.length}</span>
                </button>
              )}
              {project ? <RowMenu label={`项目「${project.name}」的操作`} actions={[
                { label: "新建会话", onSelect: () => {
                  onSelectProject(project.id);
                  setCollapsed((previous) => { const next = new Set(previous); next.delete(group.key); return next; });
                  onCreate({ projectId: project.id });
                } },
                { label: "在资源管理器中打开", onSelect: () => onOpenProjectDir(project) },
                { label: "重命名", onSelect: () => setRenamingProjectId(project.id) },
                { label: "移除项目", danger: true, onSelect: () => onDeleteProject(project.id) },
              ]} /> : !!group.key && !search.trim() ? <RowMenu label={`目录分组「${group.name}」的操作`} actions={[
                { label: "在此目录新建会话", onSelect: () => {
                  setCollapsed((previous) => { const next = new Set(previous); next.delete(group.key); return next; });
                  onCreate({ projectPath: group.key });
                } },
                { label: "组内会话移入回收站", danger: true, onSelect: () => {
                  group.sessions.forEach((session) => onDelete(session.id));
                } },
              ]} /> : null}
            </div>
            {expanded && <ul>
              {group.sessions.map((session) => {
                const isDrop = drop?.kind === "session" && drop.id === session.id;
                return <SessionItem key={session.id} session={session} active={session.id === activeId} canDrag={canDrag}
                  dragClass={`${drag?.kind === "session" && drag.id === session.id ? "dragging" : ""} ${isDrop ? `drop-${drop.before ? "before" : "after"}` : ""}`}
                  dragHandlers={{
                    onDragStart: (event) => {
                      if ((event.target as HTMLElement).closest(".row-menu-trigger, input")) { event.preventDefault(); return; }
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", session.id);
                      setDrag({ kind: "session", id: session.id });
                    },
                    onDragOver: (event) => {
                      if (drag?.kind !== "session" || drag.id === session.id || !group.sessions.some((item) => item.id === drag.id)) return;
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setDrop({ kind: "session", id: session.id, before: event.clientY < rect.top + rect.height / 2 });
                    },
                    onDrop: (event) => {
                      if (drag?.kind !== "session") return;
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      dropSession(group, session.id, event.clientY < rect.top + rect.height / 2);
                    },
                    onDragEnd: clearDrag,
                  }}
                  onSelect={() => onSelect(session.id)} onRename={(name) => onRename(session.id, name)}
                  onDelete={() => onDelete(session.id)} onTogglePin={() => onTogglePin(session.id, !session.pinned)} onOpenDir={() => onOpenDir(session)} />;
              })}
              {!group.sessions.length && <li className="session-group-empty">暂无会话</li>}
            </ul>}
          </div>
        );
      })}
      {!groups.length && <p className="session-empty">{search.trim() ? "没有匹配的会话或项目" : "创建会话，开始新的任务"}</p>}
      {projectDialogOpen && <ProjectDialog onCancel={() => setProjectDialogOpen(false)} onCreated={(project) => {
        onProjectCreated(project);
        setProjectDialogOpen(false);
      }} onError={onError} />}
    </div>
  );
}
