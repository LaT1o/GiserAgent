import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  answerSessionQuestion,
  approveSession,
  branchSession,
  cancelSession,
  clearTrash,
  compactSession,
  createSession,
  deleteProject,
  deleteSession,
  editMessage,
  fetchHistory,
  fetchModels,
  fetchProjects,
  fetchSettings,
  listSessions,
  pinSession,
  renameSession,
  reorderProjects,
  reorderSessions,
  restoreSession,
  sendMessage,
  setSessionMode,
  setSessionModel,
  setSessionPermissions,
  setThinkingLevel,
  subscribeEvents,
  updateSettings,
} from "./api/client";
import type {
  AgentEvent,
  AppSettings,
  AvailableModel,
  ModelRef,
  Project,
  SessionInfo,
  SessionMode,
  ThinkingLevel,
  UserMessageImage,
} from "./types";
import SessionList from "./components/SessionList";
import TimelinePanel from "./components/TimelinePanel";
import MapPanel from "./components/MapPanel";
import MapLayerList from "./components/MapLayerList";
import SettingsDialog from "./components/SettingsDialog";
import PanelSplitter from "./components/PanelSplitter";
import RowSplitter from "./components/RowSplitter";
import { useResizablePanels } from "./hooks/useResizablePanels";
import { useVerticalSplit } from "./hooks/useVerticalSplit";
import { useMapWorkspace, type MapContext } from "./map/useMapWorkspace";
import type { TimelineItem } from "./components/TimelinePanel";
import { nextKey, reduceEvent } from "./timeline";

/** 「按此计划执行」按钮发送的固定文案（sendText 与输入框遗留清理共用） */
const EXECUTE_PLAN_TEXT = "请按上述计划开始执行。";

export default function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [trashSessions, setTrashSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [itemsBySession, setItemsBySession] = useState<Record<string, TimelineItem[]>>({});
  const [input, setInput] = useState("");
  const [busyBySession, setBusyBySession] = useState<Record<string, boolean>>({});
  /** 执行中排队待发的消息（按会话分桶；运行结束自动按序发送，点击队列项可打断立即发送） */
  const [queuedBySession, setQueuedBySession] = useState<
    Record<string, { key: string; text: string; images?: UserMessageImage[] }[]>
  >({});
  const [error, setError] = useState<string | null>(null);
  /** 错误条退出动画标记：3 秒后上飘淡出 */
  const [errorLeaving, setErrorLeaving] = useState(false);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  /** 解析后的默认模型（用户设置优先，否则首提供商首模型；用于解析占用条窗口等兜底） */
  const [resolvedDefaultModel, setResolvedDefaultModel] = useState<ModelRef | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const sessionListRevision = useRef(0);
  const reorderingSessions = useRef(false);
  /** 明暗主题（默认暗色，localStorage 持久化，挂 <html data-theme>） */
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    localStorage.getItem("giser-theme") === "light" ? "light" : "dark"
  );
  /** 每会话最近一轮 token 账单（上下文占用条数据源） */
  const [usageBySession, setUsageBySession] = useState<Record<string, { input: number; totalTokens: number }>>({});
  /** 每会话已应用的最大事件 seq（历史回放与 SSE 去重） */
  const maxSeqRef = useRef<Record<string, number>>({});
  /** 正在编辑的历史用户消息（原地替换：提交后其后轨迹被替换） */
  const [editing, setEditing] = useState<{ sessionId: string; seq: number } | null>(null);
  /** 会话导航历史（浏览器式 back/forward）：index 指向当前会话在 history 中的位置 */
  const navRef = useRef<{ history: string[]; index: number }>({ history: [], index: -1 });
  const [navMeta, setNavMeta] = useState({ canBack: false, canForward: false });

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  const activeProject = selectedProjectId
    ? projects.find((project) => project.id === selectedProjectId) ?? null
    : null;
  const sessionProject = activeSession?.projectPath
    ? projects.find((project) => project.path === activeSession.projectPath) ?? null
    : null;
  const mapContext = useMemo<MapContext | null>(() => {
    if (activeProject) {
      return { key: `project:${activeProject.id}`, projectId: activeProject.id, title: activeProject.name };
    }
    if (activeSession) {
      const tail = activeSession.projectPath?.replace(/\\/g, "/").split("/").filter(Boolean).pop();
      return {
        key: `session:${activeSession.id}`,
        sessionId: activeSession.id,
        title: sessionProject?.name ?? (tail === "temp" ? "临时会话" : tail ?? "临时会话"),
      };
    }
    return null;
  }, [activeProject, activeSession, sessionProject]);
  const items = activeId ? itemsBySession[activeId] ?? [] : [];
  const busy = activeId ? busyBySession[activeId] ?? false : false;
  /** WebGIS 面板开关（地图入口位于左侧底部；会话间共享开关状态） */
  const [mapOpen, setMapOpen] = useState(false);
  /** 地图数据版本：当前会话的 Agent 地图工具调用变化时刷新，项目级地图另有定时收敛。
   *  `gis_` 前缀为改名前的历史轨迹，一并计数以保持回放一致。 */
  const mapRevision = useMemo(
    () =>
      items.filter(
        (it) =>
          it.kind === "tool" &&
          (it.tool.startsWith("map_") || it.tool.startsWith("gis_"))
      ).length,
    [items]
  );
  const mapVisible = mapOpen && !!mapContext;
  const panelSizes = useResizablePanels(mapVisible);
  /** 侧栏内部：会话列表与图层列表的高度分配（默认五五平分，可拖动） */
  const sidebarSplit = useVerticalSplit({
    storageKey: "giser-sidebar-split",
    defaultRatio: 0.5,
    minFirst: 140,
    minSecond: 120,
  });
  // 地图工作区由 App 持有：侧栏图层列表与中间地图共享同一份状态。
  const map = useMapWorkspace(mapContext, mapRevision, settings?.map?.basemap ?? "tianditu");

  const setBusyFor = useCallback((id: string, value: boolean) => {
    setBusyBySession((prev) => ({ ...prev, [id]: value }));
  }, []);

  const updateSessionInList = useCallback((session: SessionInfo) => {
    sessionListRevision.current++;
    setSessions((prev) => prev.map((s) => (s.id === session.id ? session : s)));
  }, []);

  /** 与服务端一致的列表排序：sortOrder（缺省排末尾）→ createdAt */
  const sortSessions = (list: SessionInfo[]) =>
    [...list].sort(
      (a, b) =>
        (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
        a.createdAt.localeCompare(b.createdAt)
    );

  const refreshSessions = useCallback(() => {
    if (reorderingSessions.current) return;
    const revision = sessionListRevision.current;
    listSessions()
      .then((r) => {
        if (revision === sessionListRevision.current && !reorderingSessions.current) setSessions(r.sessions);
      })
      .catch(() => {});
  }, []);

  const refreshTrash = useCallback(() => {
    listSessions(true)
      .then((r) => setTrashSessions(r.sessions))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 899px)");
    const onChange = () => { if (!media.matches) setSidebarOpen(false); };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    sidebarRef.current?.querySelector<HTMLButtonElement>(".sidebar-close")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSidebarOpen(false);
      }
      if (event.key !== "Tab" || document.querySelector(".floating-panel, .dialog-overlay")) return;
      const targets = [...(sidebarRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex='0']") ?? [])]
        .filter((element) => element.getClientRects().length);
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previousFocus?.focus({ preventScroll: true });
    };
  }, [sidebarOpen]);

  // 错误条自动消失：3 秒后进入上飘淡出，再 350ms 清空；新错误（文本变化）重置计时
  useEffect(() => {
    if (!error) return;
    setErrorLeaving(false);
    const hide = setTimeout(() => setErrorLeaving(true), 3000);
    const clear = setTimeout(() => setError(null), 3350);
    return () => {
      clearTimeout(hide);
      clearTimeout(clear);
    };
  }, [error]);

  /** 切换到指定会话（导航历史前进/后退与侧栏点击共用：同步选中项目并收起抽屉侧栏） */
  const applyNavSession = (id: string) => {
    setSelectedProjectId(
      projects.find((project) => project.path === sessions.find((s) => s.id === id)?.projectPath)?.id ?? null
    );
    setActiveId(id);
    setSidebarOpen(false);
  };

  /** 用户主动进入某会话：截断前进分支后入栈（重复切换同会话不入栈） */
  const pushNav = (id: string) => {
    const nav = navRef.current;
    if (nav.history[nav.index] === id) return;
    nav.history = [...nav.history.slice(0, nav.index + 1), id].slice(-50);
    nav.index = nav.history.length - 1;
    setNavMeta({ canBack: nav.index > 0, canForward: false });
  };

  /** 浏览器式后退/前进：沿历史逐格移动，跳过已删除的会话 */
  const stepNav = (direction: -1 | 1) => {
    const nav = navRef.current;
    let index = nav.index;
    while (index + direction >= 0 && index + direction < nav.history.length) {
      index += direction;
      const id = nav.history[index];
      if (sessions.some((s) => s.id === id)) {
        nav.index = index;
        setNavMeta({ canBack: index > 0, canForward: index < nav.history.length - 1 });
        applyNavSession(id);
        return;
      }
    }
    setNavMeta({ canBack: nav.index > 0, canForward: nav.index < nav.history.length - 1 });
  };

  const handleSelectSession = (id: string) => {
    pushNav(id);
    applyNavSession(id);
  };

  /** 会话列表轮询（状态徽标刷新）与全局数据（模型/设置）加载 */
  useEffect(() => {
    refreshSessions();
    const timer = setInterval(refreshSessions, 4000);
    return () => clearInterval(timer);
  }, [refreshSessions]);

  // 主题应用：<html data-theme> 驱动 CSS 变量切换，localStorage 持久化
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("giser-theme", theme);
  }, [theme]);

  useEffect(() => {
    fetchModels()
      .then((r) => setModels(r.models))
      .catch(() => {});
    fetchSettings()
      .then((r) => {
        setSettings(r.settings);
        setResolvedDefaultModel(r.resolvedDefaultModel ?? null);
      })
      .catch(() => {});
    fetchProjects()
      .then((r) => setProjects(r.projects))
      .catch(() => {});
    // 回收站入口在设置页：每次打开设置时刷新，保证列表是最新状态
    if (settingsOpen) refreshTrash();
  }, [settingsOpen, refreshTrash]);

  // 切换会话时退出编辑态（气泡内联草稿不跨会话保留）
  useEffect(() => {
    setEditing(null);
  }, [activeId]);

  const applyEvent = useCallback(
    (sessionId: string, event: AgentEvent) => {
      setItemsBySession((prev) => ({
        ...prev,
        [sessionId]: reduceEvent(prev[sessionId] ?? [], event),
      }));
      if (event.type === "turn.usage" && event.usage) {
        // 占用口径 = input + cacheRead（缓存命中的部分也是实际上下文）
        const u = event.usage;
        const contextInput = u.input + (u.cacheRead ?? 0);
        setUsageBySession((prev) => ({
          ...prev,
          [sessionId]: { input: contextInput, totalTokens: u.totalTokens },
        }));
      }
      if (event.type === "session.completed") {
        setBusyFor(sessionId, false);
      }
      if (event.type === "session.updated" && event.session) {
        updateSessionInList(event.session);
      }
    },
    [setBusyFor, updateSessionInList]
  );

  /**
   * 重新拉取某会话历史并原子重建时间线（切换会话与编辑重发后共用）。
   * maxSeq 直接取回放结果的最大值：编辑重发会复用 seq，必须重置去重水位，
   * 否则新事件的 seq 会被旧水位误判为重复帧丢弃。
   */
  const reloadHistory = useCallback(async (sid: string) => {
    try {
      const { records } = await fetchHistory(sid, 0);
      const rebuilt = records.reduce<TimelineItem[]>((list, r) => reduceEvent(list, r.event), []);
      setItemsBySession((prev) => ({ ...prev, [sid]: rebuilt }));
      // 回放恢复最近一轮 token 账单（占用条刷新后不丢失；口径 = input + cacheRead）
      const lastUsage = [...records].reverse().find((r) => r.event.type === "turn.usage")?.event.usage;
      setUsageBySession((prev) => {
        const next = { ...prev };
        if (lastUsage) {
          next[sid] = {
            input: lastUsage.input + (lastUsage.cacheRead ?? 0),
            totalTokens: lastUsage.totalTokens,
          };
        } else {
          delete next[sid];
        }
        return next;
      });
      maxSeqRef.current[sid] = records.length ? records[records.length - 1].seq : -1;
    } catch {
      /* 历史拉取失败退化为纯增量模式 */
    }
  }, []);

  /**
   * 切换会话：并行开 SSE 与拉取历史。
   * 历史到达后全量重建时间线并记录 maxSeq；SSE 事件 seq≤maxSeq 的旧帧丢弃。
   * 全量重建是原子覆盖，SSE 与 fetch 的先后竞态均收敛到一致结果。
   */
  useEffect(() => {
    if (!activeId) return;

    const unsubscribe = subscribeEvents(activeId, (event) => {
      const seq = event.seq ?? -1;
      if (seq >= 0 && seq <= (maxSeqRef.current[activeId] ?? -1)) return;
      if (seq >= 0) maxSeqRef.current[activeId] = seq;
      applyEvent(activeId, event);
    });

    void reloadHistory(activeId);

    return () => {
      unsubscribe();
    };
  }, [activeId, applyEvent, reloadHistory]);

  const handleCreate = async (input?: {
    projectId?: string;
    projectPath?: string;
  }): Promise<boolean> => {
    try {
      setError(null);
      // 新建一律先建「临时会话」：不进列表，发送首条消息后由服务端转正式
      const { session } = await createSession({ ...input, draft: true });
      sessionListRevision.current++;
      setSessions((prev) => sortSessions([...prev, session]));
      setSelectedProjectId(projects.find((project) => project.path === session.projectPath)?.id ?? null);
      setSidebarOpen(false);
      setItemsBySession((prev) => ({ ...prev, [session.id]: [] }));
      maxSeqRef.current[session.id] = -1;
      pushNav(session.id);
      setActiveId(session.id);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  /**
   * 启动（或删除当前会话后）没有选中会话时，自动开一个临时会话。
   * 临时会话带 draft 标记：侧栏列表隐藏它；发送首条消息后服务端清除标记并广播
   * session.updated，前端 updateSessionInList 会让它立刻出现在列表里。
   * 桌面端冷启动时 server 可能晚于前端就绪：固定次数重试会在 server 慢就绪时
   * 永久停在「未选择会话」（effect 依赖 activeId 不再变化），因此退避重试不设上限
   * （4s 封顶），直到建上或用户已自行选中会话（activeIdRef 跟踪，不与用户抢焦点）。
   * 失败静默重试不打错误条；手动「新建会话」仍走 handleCreate 的报错路径。
   */
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const draftCreating = useRef(false);
  useEffect(() => {
    if (activeId || draftCreating.current) return;
    draftCreating.current = true;
    void (async () => {
      try {
        let delay = 800;
        while (!activeIdRef.current) {
          try {
            const { session } = await createSession({ draft: true });
            sessionListRevision.current++;
            setSessions((prev) => sortSessions([...prev, session]));
            setSelectedProjectId(null);
            setItemsBySession((prev) => ({ ...prev, [session.id]: [] }));
            maxSeqRef.current[session.id] = -1;
            // 请求在途期间用户可能已自行选中会话：不覆盖选择，孤儿 draft 留给服务端重启清理
            if (activeIdRef.current) return;
            setSidebarOpen(false);
            pushNav(session.id);
            setActiveId(session.id);
            return;
          } catch (err) {
            console.warn("自动创建临时会话失败，稍后重试", err);
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 4000);
        }
      } finally {
        draftCreating.current = false;
      }
    })();
    // 仅在「无选中会话」时触发；循环内经 activeIdRef 读最新选中，避免闭包过期
  }, [activeId]);

  /** 发送文本（输入框与"按此计划执行"共用）：本地渲染 user 项并置忙碌 */
  const sendText = async (sid: string, text: string, images?: UserMessageImage[]) => {
    setBusyFor(sid, true);
    setItemsBySession((prev) => ({
      ...prev,
      [sid]: [
        ...(prev[sid] ?? []),
        {
          kind: "user",
          key: nextKey(),
          text,
          ...(images?.length ? { images } : {}),
        } as TimelineItem,
      ],
    }));
    try {
      const { seq } = await sendMessage(sid, text, images);
      // 补上服务端分配的 seq（分支/编辑入口依赖它定位历史消息）；
      // SSE 回环可能已先行补齐，按「末尾同文本且无 seq」条件匹配
      if (typeof seq === "number") {
        setItemsBySession((prev) => {
          const list = prev[sid] ?? [];
          const idx = [...list]
            .reverse()
            .findIndex((it) => it.kind === "user" && it.text === text && it.seq === undefined);
          if (idx < 0) return prev;
          const realIdx = list.length - 1 - idx;
          const next = [...list];
          next[realIdx] = { ...next[realIdx], seq } as TimelineItem;
          return { ...prev, [sid]: next };
        });
      }
    } catch (err) {
      setBusyFor(sid, false);
      setError((err as Error).message);
    }
  };

  /** 进入编辑态（草稿在气泡组件内维护，不回填底部输入框） */
  const handleEditStart = (seq: number) => {
    if (!activeId || busy) return;
    setEditing({ sessionId: activeId, seq });
  };

  /**
   * 提交编辑重发（原地替换）：本地先截断到该消息之前并乐观渲染新文本，再调服务端。
   * 不做整表重载——服务端 emit 走异步 WriteStream 落盘，紧随其后的历史拉取存在
   * 读到旧快照的竞态（会把刚重发的用户消息吞掉）；后续回答由 SSE 流式到达。
   */
  const handleEditSubmit = async (seq: number, text: string) => {
    const trimmed = text.trim();
    if (!activeId || !trimmed || busy) return;
    const sid = activeId;
    const idx = items.findIndex((it) => it.kind === "user" && it.seq === seq);
    if (idx < 0) {
      setError("未找到要编辑的消息，请刷新后重试");
      return;
    }
    const target = items[idx] as Extract<TimelineItem, { kind: "user" }>;
    const snapshotItems = items;
    const snapshotUsage = usageBySession[sid] ?? null;
    const snapshotMaxSeq = maxSeqRef.current[sid];
    const nextItems = items.slice(0, idx);
    nextItems.push({
      kind: "user",
      key: nextKey(),
      text: trimmed,
      seq,
      ...(target.images?.length ? { images: target.images } : {}),
    });
    setEditing(null);
    setItemsBySession((prev) => ({ ...prev, [sid]: nextItems }));
    setUsageBySession((prev) => {
      const next = { ...prev };
      delete next[sid];
      return next;
    });
    // 服务端会把 nextSeq 重置到该 seq：去重水位同步到 seq，同 seq 的 live
    // user.message 帧按重复丢弃，其后的回答增量（seq 更大）正常应用
    maxSeqRef.current[sid] = seq;
    setBusyFor(sid, true);
    try {
      await editMessage(sid, seq, trimmed);
    } catch (err) {
      setItemsBySession((prev) => ({ ...prev, [sid]: snapshotItems }));
      setUsageBySession((prev) => {
        const next = { ...prev };
        if (snapshotUsage) next[sid] = snapshotUsage;
        else delete next[sid];
        return next;
      });
      maxSeqRef.current[sid] = snapshotMaxSeq;
      setBusyFor(sid, false);
      setError((err as Error).message);
    }
  };

  const handleSend = async (images?: UserMessageImage[]) => {
    if (!activeId || !input.trim()) return;
    const text = input.trim();
    setInput("");
    // 运行中不拦截：消息进入该会话的队列，运行结束由下方 drain effect 自动按序发送
    if (busy) {
      setQueuedBySession((prev) => ({
        ...prev,
        [activeId]: [...(prev[activeId] ?? []), { key: nextKey(), text, images }],
      }));
      return;
    }
    await sendText(activeId, text, images);
  };

  const handleCancel = async () => {
    if (!activeId) return;
    try {
      await cancelSession(activeId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 点击队列消息：置顶该条并停止当前输出，停止后 drain effect 会立即把它发出 */
  const handleQueueForce = async (key: string) => {
    if (!activeId || !busy) return;
    setQueuedBySession((prev) => {
      const list = prev[activeId] ?? [];
      const target = list.find((m) => m.key === key);
      if (!target) return prev;
      return { ...prev, [activeId]: [target, ...list.filter((m) => m.key !== key)] };
    });
    try {
      await cancelSession(activeId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 从队列移除一条 */
  const handleQueueRemove = (key: string) => {
    if (!activeId) return;
    setQueuedBySession((prev) => ({
      ...prev,
      [activeId]: (prev[activeId] ?? []).filter((m) => m.key !== key),
    }));
  };

  // 队列 drain：某会话空闲且队列非空时取出队首发送（发送会重新置忙，下次空闲再发
  // 下一条，天然按序）。sendText 每次渲染重建，不入依赖避免重复触发。
  useEffect(() => {
    for (const [sid, queue] of Object.entries(queuedBySession)) {
      if (!queue.length || busyBySession[sid]) continue;
      const [next, ...rest] = queue;
      setQueuedBySession((prev) => ({ ...prev, [sid]: rest }));
      void sendText(sid, next.text, next.images);
      break;
    }
  }, [busyBySession, queuedBySession]);

  /** 切换会话模型（会话级；restart 恢复保持） */
  const handleModelChange = async (model: ModelRef) => {
    if (!activeSession) return;
    try {
      const { session } = await setSessionModel(activeSession.id, model);
      updateSessionInList(session);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 设为默认模型（写入应用设置，新会话继承） */
  const handleSetDefaultModel = async (model: ModelRef) => {
    try {
      const { settings: saved } = await updateSettings({ defaultModel: model });
      setSettings(saved);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 设置思考强度（服务端按模型能力钳制后回传最新会话快照） */
  const handleThinkingChange = async (level: ThinkingLevel) => {
    if (!activeSession) return;
    try {
      const { session } = await setThinkingLevel(activeSession.id, level);
      updateSessionInList(session);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 手动压缩当前会话上下文 */
  const handleCompact = async () => {
    if (!activeId) return;
    try {
      await compactSession(activeId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 从某条用户消息处分支：创建新会话并切换（历史为该轮之前的前缀） */
  const handleBranch = async (fromSeq: number) => {
    if (!activeId) return;
    try {
      const { session } = await branchSession(activeId, fromSeq);
      sessionListRevision.current++;
      setSessions((prev) => sortSessions([...prev, session]));
      setSelectedProjectId(projects.find((project) => project.path === session.projectPath)?.id ?? null);
      setSidebarOpen(false);
      maxSeqRef.current[session.id] = -1;
      pushNav(session.id);
      setActiveId(session.id);
      // 切换后由会话切换 effect 拉取历史回放（含复制过来的前缀轨迹）
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 保存应用设置（压缩阈值 / 默认模型） */
  const handleSaveSettings = async (next: Partial<AppSettings>) => {
    try {
      const { settings: saved } = await updateSettings(next);
      setSettings(saved);
    } catch (err) {
      setError((err as Error).message);
      throw err;
    }
  };

  /** 解除项目注册（会话数据不动；本地移除后侧栏按路径重新分组） */
  const handleDeleteProject = async (projectId: string) => {
    try {
      await deleteProject(projectId);
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
      setSelectedProjectId((id) => id === projectId ? null : id);
      refreshSessions();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 审批：本地立即置状态，再调 API（失败回弹） */
  const handleApprove = async (requestId: string, approved: boolean) => {
    if (!activeId) return;
    setItemsBySession((prev) => ({
      ...prev,
      [activeId]: (prev[activeId] ?? []).map((it) =>
        it.kind === "approval" && it.requestId === requestId
          ? { ...it, status: approved ? "approved" : "denied" }
          : it
      ),
    }));
    try {
      await approveSession(activeId, requestId, approved);
    } catch (err) {
      // 「不存在或已处理」多为超时自动拒绝/重复提交：服务端已幂等补发终态事件，
      // 本地按点击结果对齐即可，不再弹全局错误打扰
      const message = (err as Error).message;
      if (!message.includes("不存在或已处理")) setError(message);
    }
  };

  /** ask_user 作答：本地立即置状态，再调 API（失败回弹） */
  const handleAnswerQuestion = async (
    requestId: string,
    payload: { answers?: Record<string, { selected: string[]; custom?: string }>; cancelled?: boolean }
  ) => {
    if (!activeId) return;
    setItemsBySession((prev) => ({
      ...prev,
      [activeId]: (prev[activeId] ?? []).map((it) =>
        it.kind === "question" && it.requestId === requestId
          ? {
              ...it,
              status: payload.cancelled ? ("cancelled" as const) : ("answered" as const),
              answers: payload.answers,
            }
          : it
      ),
    }));
    try {
      await answerSessionQuestion(activeId, requestId, payload);
    } catch (err) {
      // 「不存在或已处理」多为超时自动结束/重复提交：服务端已幂等补发终态事件，
      // 本地按提交结果对齐即可，不再弹全局错误打扰
      const message = (err as Error).message;
      if (!message.includes("不存在或已处理")) setError(message);
    }
  };

  const handleRename = async (id: string, title: string) => {
    try {
      const { session } = await renameSession(id, title);
      updateSessionInList(session);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 置顶/取消置顶：服务端移动 sortOrder 后本地按新序重排 */
  const handleTogglePin = async (id: string, pinned: boolean) => {
    try {
      const { session } = await pinSession(id, pinned);
      sessionListRevision.current++;
      setSessions((prev) => sortSessions(prev.map((s) => (s.id === session.id ? session : s))));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 排序提交期间暂缓轮询，避免旧响应覆盖本地拖动结果。 */
  const handleReorderSessions = (orderedIds: string[]) => {
    if (reorderingSessions.current) return;
    reorderingSessions.current = true;
    sessionListRevision.current++;
    setSessions((prev) => {
      const byId = new Map(prev.map((s) => [s.id, s]));
      const next: SessionInfo[] = [];
      for (const id of orderedIds) {
        const found = byId.get(id);
        if (found) {
          next.push({ ...found, sortOrder: next.length });
          byId.delete(id);
        }
      }
      for (const rest of byId.values()) next.push({ ...rest, sortOrder: next.length });
      return next;
    });
    reorderSessions(orderedIds).catch((err) => {
      setError((err as Error).message);
    }).finally(() => {
      reorderingSessions.current = false;
      refreshSessions();
    });
  };

  const handleReorderProjects = (orderedIds: string[]) => {
    setProjects((prev) => {
      const byId = new Map(prev.map((p) => [p.id, p]));
      const next: Project[] = [];
      for (const id of orderedIds) {
        const found = byId.get(id);
        if (found) {
          next.push(found);
          byId.delete(id);
        }
      }
      for (const rest of byId.values()) next.push(rest);
      return next;
    });
    reorderProjects(orderedIds).catch((err) => setError((err as Error).message));
  };

  /** 在资源管理器打开会话目录；浏览器环境复制路径并提示 */
  const handleOpenSessionDir = (session: SessionInfo) => {
    if (window.giserDesktop?.openPath) {
      void window.giserDesktop.openPath(session.dir);
      return;
    }
    void navigator.clipboard?.writeText(session.dir).then(
      () => setError(`浏览器环境无法直接打开资源管理器，会话目录路径已复制：${session.dir}`),
      () => setError(`会话目录：${session.dir}`)
    );
  };

  /** 在资源管理器打开项目注册路径；浏览器环境复制路径并提示 */
  const handleOpenProjectDir = (project: Project) => {
    if (window.giserDesktop?.openPath) {
      void window.giserDesktop.openPath(project.path);
      return;
    }
    void navigator.clipboard?.writeText(project.path).then(
      () => setError(`浏览器环境无法直接打开资源管理器，项目路径已复制：${project.path}`),
      () => setError(`项目路径：${project.path}`)
    );
  };

  /** 软删除：移入回收站（不再二次确认） */
  const handleDelete = async (id: string) => {
    try {
      await deleteSession(id);
      sessionListRevision.current++;
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeId === id) setActiveId(null);
      // 导航历史剔除已删会话，避免后退/前进命中失效项
      const nav = navRef.current;
      nav.history = nav.history.filter((item) => item !== id);
      nav.index = Math.min(nav.index, nav.history.length - 1);
      setNavMeta({ canBack: nav.index > 0, canForward: nav.index < nav.history.length - 1 });
      refreshTrash();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRestore = async (id: string) => {
    try {
      await restoreSession(id);
      refreshTrash();
      refreshSessions();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handlePurge = async (id: string) => {
    try {
      await deleteSession(id, true);
      setTrashSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 清空回收站：彻底删除全部软删会话（不再二次确认） */
  const handleClearTrash = async () => {
    try {
      const { purged, failed } = await clearTrash();
      if (failed) setError(`回收站清空完成：已彻底删除 ${purged} 个，${failed} 个失败（可重试）`);
      refreshTrash();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /**
   * 模式档位选择（状态条 Plan / Act / YOLO）：
   * plan → mode=plan（审批策略不动）；act → mode=act + approval=smart；yolo → mode=act + approval=full。
   * 旧会话的 ask 值在点 Act 时被修正为 smart。
   */
  const handleModeSelect = async (target: "plan" | "act" | "yolo") => {
    if (!activeSession) return;
    const sid = activeSession.id;
    const nextMode: SessionMode = target === "plan" ? "plan" : "act";
    const nextApproval = target === "yolo" ? "full" : target === "act" ? "smart" : undefined;
    if (
      activeSession.mode === nextMode &&
      (nextApproval === undefined || activeSession.permissions.approval === nextApproval)
    ) {
      return;
    }
    try {
      let session = activeSession;
      if (session.mode !== nextMode) {
        session = (await setSessionMode(sid, nextMode)).session;
      }
      if (nextApproval && session.permissions.approval !== nextApproval) {
        session = (await setSessionPermissions(sid, { ...session.permissions, approval: nextApproval })).session;
      }
      updateSessionInList(session);
    } catch (err) {
      setError((err as Error).message);
      // 两步调用可能只成功一步：失败时回读服务端状态收敛
      refreshSessions();
    }
  };

  /** plan 模式一键执行：切回 act 并自动发起执行消息 */
  const handleExecutePlan = async () => {
    if (!activeSession || busy) return;
    const sid = activeSession.id;
    try {
      let session = activeSession;
      if (session.mode !== "act") {
        session = (await setSessionMode(sid, "act")).session;
      }
      // 旧会话的 ask 默认值按 Act 语义修正为智能批准（YOLO 的 full 保持不动）
      if (session.permissions.approval === "ask") {
        session = (await setSessionPermissions(sid, { ...session.permissions, approval: "smart" })).session;
      }
      updateSessionInList(session);
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    // 执行是独立发送通道：清掉输入框的遗留内容，避免「文字还留在聊天框」的观感——
    // 用户事先手动预打了同一句时（Enter 被 busy 拦下未发出）清空，其他无关草稿不动。
    if (input.trim() === EXECUTE_PLAN_TEXT) setInput("");
    await sendText(sid, EXECUTE_PLAN_TEXT);
  };

  return (
    <div
      className={`app ${sidebarOpen ? "sidebar-open" : ""} ${mapVisible ? "map-open" : ""}`}
      style={{
        "--sidebar-width": `${panelSizes.sizes.sidebar}px`,
        "--chat-width": `${panelSizes.sizes.chat}px`,
      } as CSSProperties}
    >
      {sidebarOpen && <button type="button" className="sidebar-backdrop" aria-label="关闭会话列表" onClick={() => setSidebarOpen(false)} />}
      <aside className="sidebar" id="app-sidebar" ref={sidebarRef} aria-label="项目与会话">
        <div className="sidebar-header">
          <span className="logo">
            <img className="logo-icon" src="/logo.png" alt="" aria-hidden="true" />
            GiserAgent
          </span>
          <span className="sidebar-nav">
            <button
              type="button"
              className="sidebar-nav-btn"
              title="返回上一个会话"
              aria-label="返回上一个会话"
              disabled={!navMeta.canBack}
              onClick={() => stepNav(-1)}
            >
              ←
            </button>
            <button
              type="button"
              className="sidebar-nav-btn"
              title="前进到下一个会话"
              aria-label="前进到下一个会话"
              disabled={!navMeta.canForward}
              onClick={() => stepNav(1)}
            >
              →
            </button>
          </span>
          <button type="button" className="sidebar-close" aria-label="关闭会话列表" onClick={() => setSidebarOpen(false)}>✕</button>
        </div>
          <div className="sidebar-body" ref={sidebarSplit.containerRef}>
            <div className="sidebar-pane" style={{ flexGrow: sidebarSplit.ratio }}>
              <SessionList
            sessions={sessions.filter((s) => !s.draft)}
            projects={projects}
            activeId={activeId}
            selectedProjectId={selectedProjectId}
            onSelect={handleSelectSession}
            onSelectProject={setSelectedProjectId}
            onCreate={handleCreate}
            onProjectCreated={(project) => {
              setProjects((prev) => [...prev, project]);
              setSelectedProjectId(project.id);
            }}
            onProjectRenamed={(project) =>
              setProjects((prev) => prev.map((p) => (p.id === project.id ? project : p)))
            }
            onDeleteProject={handleDeleteProject}
            onReorderProjects={handleReorderProjects}
            onRename={handleRename}
            onDelete={handleDelete}
            onTogglePin={handleTogglePin}
            onReorderSessions={handleReorderSessions}
            onOpenDir={handleOpenSessionDir}
            onOpenProjectDir={handleOpenProjectDir}
            onError={setError}
              />
            </div>
            {mapContext && (
              <>
                <RowSplitter
                  label="调整图层列表高度"
                  onResizeStart={sidebarSplit.startResize}
                  onAdjust={sidebarSplit.adjust}
                />
                <div className="sidebar-pane" style={{ flexGrow: 1 - sidebarSplit.ratio }}>
                  <MapLayerList workspace={map} />
                </div>
              </>
            )}
          </div>
        <div className="sidebar-footer">
          <button
            className={`sidebar-footer-btn sidebar-map-toggle ${mapOpen ? "active" : ""}`}
            title={mapContext ? (mapOpen ? "关闭地图窗口" : "打开地图窗口") : "选择项目或会话后可打开地图"}
            disabled={!mapContext}
            onClick={() => setMapOpen((open) => !open)}
          >
            <span aria-hidden="true">🗺</span><span>地图</span>
          </button>
          <button
            className="sidebar-footer-btn"
            title={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            <span aria-hidden="true">{theme === "dark" ? "☀" : "🌙"}</span><span>主题</span>
          </button>
          <button
            className="sidebar-footer-btn"
            title="应用设置（默认模型 / 提供商 / 技能 / 压缩阈值 / 回收站）"
            onClick={() => setSettingsOpen(true)}
          >
            <span aria-hidden="true">⚙</span><span>设置</span>
          </button>
        </div>
      </aside>
      <PanelSplitter panel="sidebar" onResizeStart={panelSizes.startResize} onAdjust={panelSizes.adjust} />
      {mapVisible && <>
        <MapPanel
          workspace={map}
          projectTitle={mapContext.title}
          basemap={settings?.map?.basemap ?? "tianditu"}
          tiandituToken={settings?.map?.tiandituToken}
          onBasemapChange={(next) => {
            // 整体提交 map：sanitize 会重建该对象，缺字段会被视为清除（密钥不能丢）
            handleSaveSettings({
              map: { ...(settings?.map ?? { basemap: "tianditu" }), basemap: next },
            }).catch(() => {
              /* 错误已由 handleSaveSettings 全局提示 */
            });
          }}
          onClose={() => setMapOpen(false)}
        />
        <PanelSplitter panel="chat" onResizeStart={panelSizes.startResize} onAdjust={panelSizes.adjust} />
      </>}
      <main className="content">
        <TimelinePanel
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          session={activeSession}
          items={items}
          busy={busy}
          input={input}
          setInput={setInput}
          models={models}
          defaultModel={settings?.defaultModel ?? resolvedDefaultModel ?? undefined}
          usage={activeId ? usageBySession[activeId] ?? null : null}
          onSend={handleSend}
          onCancel={handleCancel}
          queue={activeId ? queuedBySession[activeId] ?? [] : []}
          onQueueForce={(key) => void handleQueueForce(key)}
          onQueueRemove={handleQueueRemove}
          onApprove={handleApprove}
          onAnswerQuestion={(requestId, payload) => void handleAnswerQuestion(requestId, payload)}
          onModeSelect={handleModeSelect}
          onExecutePlan={handleExecutePlan}
          onRename={(title) => {
            if (activeSession) void handleRename(activeSession.id, title);
          }}
          onModelChange={handleModelChange}
          onSetDefaultModel={handleSetDefaultModel}
          onThinkingChange={handleThinkingChange}
          onCompact={handleCompact}
          onBranch={handleBranch}
          editing={editing && editing.sessionId === activeId ? { seq: editing.seq } : null}
          onEditStart={handleEditStart}
          onEditSubmit={handleEditSubmit}
          onCancelEdit={() => setEditing(null)}
        />
      </main>
      {settingsOpen && settings && (
        <SettingsDialog
          settings={settings}
          models={models}
          trashSessions={trashSessions}
          onClose={() => setSettingsOpen(false)}
          onSave={handleSaveSettings}
          onModelsChanged={() => {
            fetchModels()
              .then((r) => setModels(r.models))
              .catch(() => {});
          }}
          onRestoreSession={handleRestore}
          onPurgeSession={handlePurge}
          onClearTrash={handleClearTrash}
          onRefreshTrash={refreshTrash}
          onError={setError}
        />
      )}
      {error && (
        <div
          className={`global-error ${errorLeaving ? "leaving" : ""}`}
          role="alert"
          onClick={() => setError(null)}
        >
          {error}（点击关闭）
        </div>
      )}
    </div>
  );
}
