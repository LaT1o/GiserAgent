/**
 * Application API 客户端。
 * 所有请求走 /api（开发期由 Vite 代理到 http://127.0.0.1:3001）。
 */

import type {
  AgentEvent,
  AppSettings,
  AvailableModel,
  DirEntry,
  GlobalSkillInfo,
  HistoryRecord,
  ImportModelInput,
  MapLayerInfo,
  ModelRef,
  Project,
  ProjectFileEntry,
  ProviderSummary,
  SessionCommand,
  SessionContextInfo,
  SessionInfo,
  SessionMode,
  SessionPermissions,
  SessionSkill,
  ThinkingLevel,
  UpstreamModel,
  UserMessageImage,
} from "../types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 无 body 的 POST 不能带 Content-Type: application/json，
  // 否则 Fastify 会因空 JSON body 返回 400
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* 忽略非 JSON 响应体 */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/** 创建会话；projectId（已注册项目）或 projectPath（直传路径）可选；draft=临时会话（首条消息后才进列表） */
export function createSession(input?: {
  projectId?: string;
  projectPath?: string;
  draft?: boolean;
}): Promise<{ session: SessionInfo }> {
  return request("/api/sessions", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

/** 会话列表；trash=true 返回回收站（软删除）会话 */
export function listSessions(trash = false): Promise<{ sessions: SessionInfo[] }> {
  return request(`/api/sessions${trash ? "?trash=1" : ""}`);
}

export function renameSession(
  sessionId: string,
  title: string
): Promise<{ session: SessionInfo }> {
  return request(`/api/sessions/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

/** 置顶 / 取消置顶（服务端把会话移到列表最前 / 末尾） */
export function pinSession(sessionId: string, pinned: boolean): Promise<{ session: SessionInfo }> {
  return request(`/api/sessions/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify({ pinned }),
  });
}

/** 侧栏拖动排序持久化（全量会话 id 按显示顺序传入） */
export function reorderSessions(orderedIds: string[]): Promise<{ accepted: boolean }> {
  return request("/api/sessions/reorder", {
    method: "POST",
    body: JSON.stringify({ orderedIds }),
  });
}

/** 项目分组拖动排序持久化（全量项目 id 按显示顺序传入） */
export function reorderProjects(orderedIds: string[]): Promise<{ accepted: boolean }> {
  return request("/api/projects/reorder", {
    method: "POST",
    body: JSON.stringify({ orderedIds }),
  });
}

/** 删除会话；purge=true 彻底删除整个会话目录（不可恢复） */
export function deleteSession(sessionId: string, purge = false): Promise<{ accepted: boolean }> {
  return request(`/api/sessions/${sessionId}${purge ? "?purge=1" : ""}`, { method: "DELETE" });
}

export function restoreSession(sessionId: string): Promise<{ session: SessionInfo }> {
  return request(`/api/sessions/${sessionId}/restore`, { method: "POST" });
}

/** 清空回收站（彻底删除全部软删会话） */
export function clearTrash(): Promise<{ accepted: boolean; purged: number; failed: number }> {
  return request("/api/sessions/trash/clear", { method: "POST" });
}

/** 切换 plan/act 模式 */
export function setSessionMode(
  sessionId: string,
  mode: SessionMode
): Promise<{ session: SessionInfo }> {
  return request(`/api/sessions/${sessionId}/mode`, {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

/** 更新会话权限（仅审批档位由模式开关驱动：act=smart / yolo=full） */
export function setSessionPermissions(
  sessionId: string,
  permissions: SessionPermissions
): Promise<{ session: SessionInfo }> {
  return request(`/api/sessions/${sessionId}/permissions`, {
    method: "POST",
    body: JSON.stringify({ permissions }),
  });
}

/** 事件历史（events.jsonl 回放），返回 seq 大于 afterSeq 的记录 */
export function fetchHistory(
  sessionId: string,
  afterSeq = 0
): Promise<{ records: HistoryRecord[] }> {
  return request(`/api/sessions/${sessionId}/history?after=${afterSeq}`);
}

export function sendMessage(
  sessionId: string,
  text: string,
  images?: UserMessageImage[]
): Promise<{ accepted: boolean; seq: number }> {
  return request(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text, ...(images?.length ? { images } : {}) }),
  });
}

/** 编辑历史用户消息并原地重发（其后轨迹被替换，返回新消息的 seq） */
export function editMessage(
  sessionId: string,
  seq: number,
  text: string
): Promise<{ accepted: boolean; seq: number }> {
  return request(`/api/sessions/${sessionId}/edit-message`, {
    method: "POST",
    body: JSON.stringify({ seq, text }),
  });
}

/** 全部可用模型（models.json 解析结果） */
export function fetchModels(): Promise<{ models: AvailableModel[] }> {
  return request("/api/models");
}

/** 切换会话模型（会话级，重启恢复保持） */
export function setSessionModel(
  sessionId: string,
  model: ModelRef
): Promise<{ session: SessionInfo }> {
  return request(`/api/sessions/${sessionId}/model`, {
    method: "POST",
    body: JSON.stringify(model),
  });
}

/** 设置会话思考强度（服务端按模型能力自动钳制） */
export function setThinkingLevel(
  sessionId: string,
  level: ThinkingLevel
): Promise<{ session: SessionInfo }> {
  return request(`/api/sessions/${sessionId}/thinking`, {
    method: "POST",
    body: JSON.stringify({ level }),
  });
}

/** 上下文占用与成分分解（占用条/详情弹窗） */
export function fetchContext(sessionId: string): Promise<{ context: SessionContextInfo }> {
  return request(`/api/sessions/${sessionId}/context`);
}

/** 模型提供商列表（不含密钥） */
export function fetchProviders(): Promise<{ providers: ProviderSummary[] }> {
  return request("/api/providers");
}

export function addProvider(input: {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey?: string;
}): Promise<{ provider: ProviderSummary }> {
  return request("/api/providers", { method: "POST", body: JSON.stringify(input) });
}

export function removeProvider(providerId: string): Promise<{ accepted: boolean }> {
  return request(`/api/providers/${encodeURIComponent(providerId)}`, { method: "DELETE" });
}

/** 编辑提供商（名称/BaseURL/密钥；apiKey 仅填写时覆盖） */
export function updateProvider(
  providerId: string,
  input: { name?: string; baseUrl?: string; apiKey?: string }
): Promise<{ provider: ProviderSummary }> {
  return request(`/api/providers/${encodeURIComponent(providerId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/** 删除提供商下指定模型 */
export function removeModels(
  providerId: string,
  modelIds: string[]
): Promise<{ provider: ProviderSummary }> {
  return request("/api/providers/remove-models", {
    method: "POST",
    body: JSON.stringify({ providerId, modelIds }),
  });
}

/** 全局技能列表（设置页 Skills 管理） */
export function fetchGlobalSkills(): Promise<{ skills: GlobalSkillInfo[] }> {
  return request("/api/skills");
}

/** 技能启用/禁用开关（写 settings.disabledSkills，会话技能加载过滤） */
export function setSkillDisabled(
  name: string,
  disabled: boolean
): Promise<{ accepted: boolean }> {
  return request("/api/skills/disabled", {
    method: "PUT",
    body: JSON.stringify({ name, disabled }),
  });
}

/** 删除全局技能目录 */
export function deleteGlobalSkill(path: string): Promise<{ accepted: boolean }> {
  return request("/api/skills", { method: "DELETE", body: JSON.stringify({ path }) });
}

/** 向提供商导入模型条目（写 models.json 并刷新内存注册） */
export function importModels(
  providerId: string,
  models: ImportModelInput[]
): Promise<{ provider: ProviderSummary }> {
  return request("/api/providers/import-models", {
    method: "POST",
    body: JSON.stringify({ providerId, models }),
  });
}

/** 探测上游模型列表（OpenAI 兼容 /models，仅探测不落盘；编辑态可只传 providerId 用已存密钥） */
export function fetchUpstreamModels(
  baseUrl: string,
  apiKey?: string,
  providerId?: string
): Promise<{ models: UpstreamModel[] }> {
  return request("/api/providers/fetch-upstream", {
    method: "POST",
    body: JSON.stringify({ baseUrl, ...(apiKey ? { apiKey } : {}), ...(providerId ? { providerId } : {}) }),
  });
}

/** 项目实体 CRUD */
export function fetchProjects(): Promise<{ projects: Project[] }> {
  return request("/api/projects");
}

export function createProject(name: string, path: string): Promise<{ project: Project }> {
  return request("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name, path }),
  });
}

export function renameProject(projectId: string, name: string): Promise<{ project: Project }> {
  return request(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function deleteProject(projectId: string): Promise<{ accepted: boolean }> {
  return request(`/api/projects/${projectId}`, { method: "DELETE" });
}

/** 目录浏览（创建项目选路径）；path 为空列盘符 */
export function fetchDirs(path?: string): Promise<{ entries: DirEntry[] }> {
  return request(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`);
}

/** 手动压缩会话上下文（instructions 为给摘要模型的定制指令） */
export function compactSession(
  sessionId: string,
  instructions?: string
): Promise<{ accepted: boolean }> {
  return request(`/api/sessions/${sessionId}/compact`, {
    method: "POST",
    ...(instructions ? { body: JSON.stringify({ instructions }) } : {}),
  });
}

/** 从历史某条用户消息处分支（保留该轮及之前内容，创建新会话） */
export function branchSession(
  sessionId: string,
  fromSeq: number
): Promise<{ session: SessionInfo }> {
  return request(`/api/sessions/${sessionId}/branch`, {
    method: "POST",
    body: JSON.stringify({ fromSeq }),
  });
}

/** 会话可用的 slash 命令（prompt 模板 + skill 映射） */
export function fetchCommands(sessionId: string): Promise<{ commands: SessionCommand[] }> {
  return request(`/api/sessions/${sessionId}/commands`);
}

/** 会话加载的技能（全局 + 项目级） */
export function fetchSkills(sessionId: string): Promise<{ skills: SessionSkill[] }> {
  return request(`/api/sessions/${sessionId}/skills`);
}

/** 项目文件浏览（@ 引用补全）；path 为项目根内相对目录 */
export function fetchProjectFiles(
  sessionId: string,
  path = ""
): Promise<{ entries: ProjectFileEntry[] }> {
  return request(
    `/api/sessions/${sessionId}/files${path ? `?path=${encodeURIComponent(path)}` : ""}`
  );
}

/** 地图图层清单（WebGIS 面板；GIS 工具产出的 GeoJSON 制品） */
export function fetchMapLayers(sessionId: string): Promise<{ layers: MapLayerInfo[] }> {
  return request(`/api/sessions/${sessionId}/map/layers`);
}

/** 项目共享地图图层清单。项目注册后所有会话共同使用这份清单。 */
export function fetchProjectMapLayers(projectId: string): Promise<{ layers: MapLayerInfo[] }> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/map/layers`);
}

/** 图层 GeoJSON 内容（服务端已登记制品；解析为对象供 OpenLayers 渲染） */
export async function fetchMapLayerGeoJSON(
  sessionId: string,
  layerId: string
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `/api/sessions/${sessionId}/map/layers/${encodeURIComponent(layerId)}/geojson`
  );
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* 忽略非 JSON 响应体 */
    }
    throw new Error(message);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** 更新项目图层状态（显示名 / 显隐 / 顺序；写入项目 .latio/webgis/map.json） */
export function updateProjectMapLayer(
  projectId: string,
  layerId: string,
  patch: { alias?: string; visible?: boolean; order?: number }
): Promise<{ layer: MapLayerInfo }> {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/map/layers/${encodeURIComponent(layerId)}`,
    { method: "PATCH", body: JSON.stringify(patch) }
  );
}

/** 从项目地图移除图层；purge=true 连 GeoJSON 制品一起删除 */
export function deleteProjectMapLayer(
  projectId: string,
  layerId: string,
  purge = false
): Promise<{ accepted: boolean; purged: boolean }> {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/map/layers/${encodeURIComponent(layerId)}${purge ? "?purge=1" : ""}`,
    { method: "DELETE" }
  );
}

/** 读取项目共享图层 GeoJSON。 */
export async function fetchProjectMapLayerGeoJSON(
  projectId: string,
  layerId: string
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/map/layers/${encodeURIComponent(layerId)}/geojson`
  );
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* 忽略非 JSON 响应体 */
    }
    throw new Error(message);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** 拖拽上传矢量数据的响应（与 webgis.ingestUploadedVectorFiles 的结果结构一致） */
export interface UploadMapLayersResult {
  success: boolean;
  uploaded: number;
  layers: MapLayerInfo[];
  failed: Array<{ dataset: string; mainFile: string; error?: string }>;
  ignored: string[];
  note?: string;
}

/** 拖拽上传矢量数据并登记为图层（FormData multipart；shp 含 sidecar、gpkg/geojson/kml、gdb 目录）。
 * 注意：不能用 request()（它会强制 JSON Content-Type），multipart 的 boundary 由浏览器自动生成。 */
async function uploadMapLayers(url: string, form: FormData): Promise<UploadMapLayersResult> {
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* 忽略非 JSON 响应体 */
    }
    throw new Error(message);
  }
  return (await res.json()) as UploadMapLayersResult;
}

export function uploadSessionMapLayers(sessionId: string, form: FormData): Promise<UploadMapLayersResult> {
  return uploadMapLayers(`/api/sessions/${encodeURIComponent(sessionId)}/map/upload`, form);
}

export function uploadProjectMapLayers(projectId: string, form: FormData): Promise<UploadMapLayersResult> {
  return uploadMapLayers(`/api/projects/${encodeURIComponent(projectId)}/map/upload`, form);
}

/** 应用设置（默认模型 / 压缩阈值）；resolvedDefaultModel 为解析后的默认模型（只读兜底） */
export function fetchSettings(): Promise<{ settings: AppSettings; resolvedDefaultModel: ModelRef | null }> {
  return request("/api/settings");
}

export function updateSettings(settings: Partial<AppSettings>): Promise<{ settings: AppSettings }> {
  return request("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function cancelSession(sessionId: string): Promise<{ accepted: boolean }> {
  return request(`/api/sessions/${sessionId}/cancel`, { method: "POST" });
}

/** 回复审批请求（approval.required 事件的 request_id） */
export function approveSession(
  sessionId: string,
  requestId: string,
  approved: boolean
): Promise<{ accepted: boolean }> {
  return request(`/api/sessions/${sessionId}/approval`, {
    method: "POST",
    body: JSON.stringify({ request_id: requestId, approved }),
  });
}

/** 回复 ask_user 结构化提问（question.required 事件的 request_id） */
export function answerSessionQuestion(
  sessionId: string,
  requestId: string,
  payload: { answers?: Record<string, { selected: string[]; custom?: string }>; cancelled?: boolean }
): Promise<{ accepted: boolean }> {
  return request(`/api/sessions/${sessionId}/question`, {
    method: "POST",
    body: JSON.stringify({ request_id: requestId, ...payload }),
  });
}

/** 订阅某会话的 SSE 事件流，返回关闭函数 */
export function subscribeEvents(
  sessionId: string,
  onEvent: (event: AgentEvent) => void
): () => void {
  const source = new EventSource(`/api/sessions/${sessionId}/events`);
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as AgentEvent);
    } catch {
      /* 忽略无法解析的帧 */
    }
  };
  // EventSource 断线自动重连（服务端设置了 retry: 3000）
  return () => source.close();
}
