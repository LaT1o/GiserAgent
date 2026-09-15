/**
 * PiAdapter：AgentAdapter 的 Pi 实现（当前唯一实现）。
 *
 * 集成方式：SDK 进程内集成（createAgentSession），每个会话一个
 * AgentSession 实例（独立工具注册表与内联扩展）。Pi 事件经 translate
 * 转为统一内部 AgentEvent 分发给订阅者，上层只见 AgentAdapter 接口。
 *
 * 持久化（重启后可继续对话）：
 * - SDK 会话经 SessionManager.create/open 落盘于 logs/（JSONL 树）
 * - meta.json 记录标题/项目路径/模式/权限等元数据
 * - events.jsonl 追加写入内部事件（跳过 delta 类），供前端历史回放
 * - 启动时扫描 meta.json 注册持久化会话，首次触达时 lazy 恢复
 *
 * 权限与模式：controlState（permissions/mode/allowedRoots）由本类与
 * permissions/planMode 两个门控扩展闭包共享；工具集增删经
 * setActiveToolsByName 生效（下一轮），范围拦截经 tool_call 立即生效。
 */

import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Api, AuthCheck, Model, ThinkingLevel as PiThinkingLevel } from "@earendil-works/pi-ai";
import { estimateMessageTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  resizeImage,
  type AgentSession,
  type DefaultResourceLoader as ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentAdapter,
  AgentHistoryRecord,
  AvailableModel,
  CreateSessionInput,
  ImportModelInput,
  ListSessionsOptions,
  ProjectFileEntry,
  ProviderSummary,
  SessionCommand,
  SessionContextInfo,
  SessionSkill,
} from "../adapter.js";
import { makeEvent, type AgentEvent, type UserMessageImage } from "../events.js";
import type {
  AgentSessionInfo,
  AgentSessionMode,
  AgentSessionStatus,
  ModelRef,
  SessionPermissions,
  ThinkingLevel,
} from "../session.js";
import { DEFAULT_SESSION_PERMISSIONS, normalizeSessionPermissions } from "../session.js";
import type { ServerConfig } from "../../config.js";
import { PLAN_ONLY_TOOLS, SERVER_DIR } from "../../config.js";
import type { AppSettings } from "../../settings.js";
import { percentToTokens } from "../../settings.js";
import {
  readAuthFile,
  readModelsFile,
  writeAuthFile,
  writeModelsFile,
  type ModelFileEntry,
  type ProviderFileEntry,
} from "../../providers.js";
import { matchModelProfile } from "../../modelProfiles.js";
import { isMapToolName, isOpenGisToolName, ensureLatioLayout, latioLayout, MapLayerStore, type MapLayer } from "../../webgis.js";
import { createArcGisTool, createOpenGisTool } from "./extensions/python-runner.js";
import { createMapInspectTool } from "./extensions/map-inspect-tool.js";
import { createOpenGisTools } from "./extensions/opengis-tools.js";
import { createMapTools } from "./extensions/map-tools.js";
import { createSubmitPlanTool } from "./extensions/submit-plan.js";
import { createAskUserTool, type AskUserQuestion, type AskUserResult } from "./extensions/ask-user.js";
import { createApprovalGate, type ApprovalRequest } from "./extensions/approvalGate.js";
import { createPermissionGuard, type SessionControlState } from "./extensions/permissions.js";
import { createPlanModeGuard } from "./extensions/planMode.js";
import {
  isReadOnlyBashCommand,
  isSafeBashCommand,
  isSafePowerShellCommand,
} from "./extensions/commandRisk.js";
import { createTodoExtension } from "./extensions/todo.js";

/** 会话元数据落盘结构（workspace/sessions/<id>/meta.json） */
interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  /** 绑定的项目目录（绝对路径；未绑定为空） */
  projectPath?: string;
  /** Agent 实际工作目录（projectPath 或会话 working） */
  cwd: string;
  mode: AgentSessionMode;
  permissions: SessionPermissions;
  /** 会话当前模型（缺省用应用默认模型） */
  model?: ModelRef;
  /** 会话思考强度（缺省 medium；切模型时由 SDK 钳制并回写） */
  thinkingLevel?: ThinkingLevel;
  /** 分支来源会话 id */
  parentSessionId?: string;
  /** 软删除时间（回收站） */
  deletedAt?: string;
  /** 手动排序序号（拖动排序持久化；缺省按创建序排在末尾） */
  sortOrder?: number;
  /** 置顶标记（置顶动作把 sortOrder 提到最前，本字段用于图标显示） */
  pinned?: boolean;
  /** SDK 会话 jsonl 文件路径（相对会话目录；旧数据为绝对路径，读取时兼容两种） */
  piSessionFile?: string;
  /** 临时会话标记：不进会话列表，发送首条用户消息时清除 */
  draft?: boolean;
  /** 已迁入项目 .latio 的会话：旧目录留下的墓碑标记（有值即跳过扫描，旧副本保留备查） */
  migratedTo?: string;
  /** 迁入时间（目标 meta 与旧目录墓碑各记一次） */
  migratedAt?: string;
  /** 迁移来源目录（仅目标 meta 记录） */
  migratedFrom?: string;
}

interface SessionEntry {
  meta: SessionMeta;
  /** workspace/sessions/<id> */
  sessionDir: string;
  status: AgentSessionStatus;
  /** null 表示仅从磁盘加载元数据，AgentSession 尚未 lazy 恢复 */
  session: AgentSession | null;
  /** 会话专属资源加载器（skills/prompt 模板查询用；随 session 生命周期） */
  loader: ResourceLoader | null;
  subscribers: Set<(event: AgentEvent) => void>;
  /** 被审批/权限/模式门控阻止的工具调用 id，用于 tool.completed 置失败态 */
  blockedCalls: Set<string>;
  /** 是否为主动关闭（软删除/退出），主动关闭不发 agent.error */
  closing: boolean;
  /** 事件单调递增序号（落盘与回放去重） */
  nextSeq: number;
  /** events.jsonl 追加写流（按需打开，软删除/退出时关闭） */
  eventsStream: WriteStream | null;
  /** 与门控扩展闭包共享的可变控制状态 */
  controlState: SessionControlState;
  /** 恢复失败原因（该会话可看历史但不可继续对话） */
  unrestorable?: string;
  /** 进行中的恢复 Promise（防并发） */
  restoring?: Promise<void>;
}

interface PendingApproval {
  sessionId: string;
  resolve: (approved: boolean) => void;
}

interface PendingQuestion {
  sessionId: string;
  resolve: (result: AskUserResult) => void;
}

/** 这些事件只服务 live 流式渲染，不落盘（回放由聚合事件重建） */
const NON_PERSISTED_EVENT_TYPES = new Set(["assistant.delta", "assistant.thinking_delta"]);

/** 上游拒绝思考档位时的错误特征（各网关措辞不一） */
const EFFORT_ERROR_PATTERN = /reasoning[_ ]?effort|thinking[_ ]?(level|budget)/i;

/** 错误信息命中思考档位问题时追加修改入口提示 */
function withEffortHint(message: string): string {
  if (!EFFORT_ERROR_PATTERN.test(message)) return message;
  return `${message}\n提示：上游可能不支持该思考档位，请在「设置 → 模型提供商 → ⚙ 模型管理」中把此模型的最高思考档位调低。`;
}

/** 执行失败信息（prompt 抛错路径）；modelId 供上游模型失效时给出切换指引 */
function describePromptError(err: unknown, modelId?: string): string {
  const message = (err as Error)?.message ?? String(err);
  // 上游网关的模型失效（临期模型过期下架、渠道移除等）：给出中文指引，避免用户对着上游 JSON 猜原因
  if (/model_not_found|No available channel|无可用渠道/i.test(message)) {
    const model = modelId ? `「${modelId}」` : "";
    return (
      `执行失败: ${message}\n` +
      `提示：当前会话模型${model}在上游已不可用（可能已过期或下架）。` +
      `请在本会话顶部的模型下拉中切换为可用模型后重试。`
    );
  }
  return `执行失败: ${withEffortHint(message)}`;
}

export class PiAdapter implements AgentAdapter {
  private sessions = new Map<string, SessionEntry>();
  private sortOrderNeedsPersist = false;
  private pendingApprovals = new Map<string, PendingApproval>();
  /** 待回答的用户提问（ask_user 工具挂起中；answerQuestion 回传后 resolve） */
  private pendingQuestions = new Map<string, PendingQuestion>();
  /** 共享的模型/凭据运行时（models.json 自定义 provider 在此解析） */
  private modelRuntime: ModelRuntime | null = null;
  private readonly modelsFile = resolve(SERVER_DIR, ".pi", "models.json");
  private readonly authFile = resolve(SERVER_DIR, ".pi", "auth.json");

  constructor(
    private config: ServerConfig,
    /** 应用设置读取器（默认模型/压缩阈值，随 PUT /api/settings 动态变化） */
    private readSettings: () => AppSettings,
    /** 已注册项目路径（注册项目的会话与地图数据存入项目内 .latio；缺省视为无项目） */
    private listProjectPaths: () => string[] = () => []
  ) {
    // models.json 是本地个人配置（不入库）：缺失时从出厂默认 models.default.json
    // 复制一份，保证新克隆环境开箱即有配置文件（密钥仍由界面配置到 auth.json）
    const defaultModelsFile = resolve(SERVER_DIR, ".pi", "models.default.json");
    if (!existsSync(this.modelsFile) && existsSync(defaultModelsFile)) {
      copyFileSync(defaultModelsFile, this.modelsFile);
      console.log("[piAdapter] models.json 缺失，已从 models.default.json 复制默认配置");
    }
    // 不校验环境变量密钥：模型提供商与密钥全部由界面配置（models.json + auth.json），
    // 未配置时应用与设置页仍可打开，发消息时由 assertModelReady 给出中文提示
    mkdirSync(config.workspaceDir, { recursive: true });
    this.scanPersistedSessions();
  }

  /** 是否已注册项目：仅注册项目使用项目内 .latio 存储（避免向未授权目录写入） */
  private isRegisteredProject(path?: string): boolean {
    if (!path) return false;
    const abs = resolve(path);
    return this.listProjectPaths().some((p) => resolve(p) === abs);
  }

  /** 注册项目的 .latio 根目录 */
  private projectLatioDir(projectPath: string): string {
    return latioLayout(projectPath).latio;
  }

  /** 中央会话根目录（临时会话与未注册路径的会话） */
  private centralSessionsDir(): string {
    return resolve(this.config.workspaceDir, "sessions");
  }

  /** 会话目录：注册项目 → <project>/.latio/sessions/<id>；其余 → 中央 workspace/sessions/<id> */
  private sessionDirFor(projectPath: string | undefined, sessionId: string): string {
    const root =
      projectPath && this.isRegisteredProject(projectPath)
        ? latioLayout(projectPath).sessions
        : this.centralSessionsDir();
    return resolve(root, sessionId);
  }

  /** 项目 .latio 布局初始化（创建项目时已建；此处为旧项目/异常缺失兜底） */
  private ensureProjectLayout(projectPath: string): void {
    ensureLatioLayout(projectPath);
  }

  /** 会话的地图图层目录：注册项目 → <project>/.latio/webgis；其余 → <sessionDir>/webgis */
  private webgisDirFor(meta: SessionMeta, sessionDir: string): string {
    return meta.projectPath && this.isRegisteredProject(meta.projectPath)
      ? resolve(this.projectLatioDir(meta.projectPath), "webgis")
      : resolve(sessionDir, "webgis");
  }

  /** SDK 会话文件绝对路径（meta 存相对会话目录的路径；旧数据为绝对路径，兼容两种） */
  private piFileAbs(meta: SessionMeta, sessionDir: string): string | undefined {
    if (!meta.piSessionFile) return undefined;
    return isAbsolute(meta.piSessionFile)
      ? meta.piSessionFile
      : resolve(sessionDir, meta.piSessionFile);
  }

  /** 记录 SDK 会话文件（优先存相对会话目录的路径，项目整体移动/复制后仍可解析） */
  private setPiFile(meta: SessionMeta, sessionDir: string, absPath?: string): void {
    if (!absPath) return;
    const rel = relative(sessionDir, absPath);
    meta.piSessionFile = rel && !rel.startsWith("..") ? rel : absPath;
  }

  /** 启动时扫描各会话目录的 meta.json，注册持久化会话（不建 AgentSession） */
  private scanPersistedSessions(): void {
    this.migrateProjectSessions();
    // 中央会话根（临时会话/未注册路径）+ 各注册项目的项目内会话根
    const roots = [this.centralSessionsDir()];
    for (const projectPath of this.listProjectPaths()) {
      roots.push(resolve(this.projectLatioDir(projectPath), "sessions"));
    }
    for (const sessionsDir of roots) this.scanSessionRoot(sessionsDir);
    this.normalizeSortOrders();
  }

  /**
   * 一次性迁移：把中央 workspace/sessions 里「已绑定注册项目」的会话复制进 <项目>/.latio/sessions。
   * 采用复制 + 校验（meta 可解析、文件数与字节总数一致）+ 标记完成：目标 meta 记 migratedFrom，
   * 旧目录 meta 记 migratedTo（扫描时跳过，旧副本保留备查，不影响历史读取）。
   * 任一步失败即删掉半成品目标目录，旧会话保持原样，下次启动重试。
   */
  private migrateProjectSessions(): void {
    const centralDir = this.centralSessionsDir();
    if (!existsSync(centralDir)) return;
    for (const name of readdirSync(centralDir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const srcDir = resolve(centralDir, name.name);
      const srcMetaFile = resolve(srcDir, "meta.json");
      if (!existsSync(srcMetaFile)) continue;
      let meta: SessionMeta | null = null;
      try {
        meta = JSON.parse(readFileSync(srcMetaFile, "utf8")) as SessionMeta;
        if (!meta?.id || meta.draft || meta.migratedTo) continue;
        if (!meta.projectPath || !this.isRegisteredProject(meta.projectPath)) continue;
        const layout = latioLayout(meta.projectPath);
        const dstDir = resolve(layout.sessions, meta.id);
        if (existsSync(resolve(dstDir, "meta.json"))) {
          // 项目内已有同名会话（此前迁移完成但标记丢失）：只补标记，不覆盖项目内数据
          this.markMigrated(srcMetaFile, meta, dstDir);
          continue;
        }
        ensureLatioLayout(meta.projectPath);
        mkdirSync(layout.sessions, { recursive: true });
        cpSync(srcDir, dstDir, { recursive: true });
        const src = treeStats(srcDir);
        const dst = treeStats(dstDir);
        const copied = JSON.parse(readFileSync(resolve(dstDir, "meta.json"), "utf8")) as SessionMeta;
        if (src.files !== dst.files || src.bytes !== dst.bytes || copied?.id !== meta.id) {
          throw new Error(
            `复制校验不一致（源 ${src.files} 文件 / ${src.bytes} 字节，目标 ${dst.files} / ${dst.bytes}）`
          );
        }
        // 目标 meta：SDK 会话文件路径改写为相对新会话目录，并记录迁移来源
        const oldAbs = this.piFileAbs(meta, srcDir);
        const inSrc = oldAbs ? !relative(srcDir, oldAbs).startsWith("..") : false;
        const migrated: SessionMeta = {
          ...copied,
          migratedFrom: srcDir,
          migratedAt: new Date().toISOString(),
        };
        delete migrated.migratedTo;
        this.setPiFile(migrated, dstDir, inSrc && oldAbs ? resolve(dstDir, relative(srcDir, oldAbs)) : oldAbs);
        writeFileSync(resolve(dstDir, "meta.json"), JSON.stringify(migrated, null, 2), "utf8");
        this.markMigrated(srcMetaFile, meta, dstDir);
        console.log(`[piAdapter] 会话已迁入项目 .latio：${meta.id} → ${dstDir}`);
      } catch (err) {
        // 失败：清掉半成品目标目录，旧会话不动，下次启动重试
        if (meta?.id && meta.projectPath && this.isRegisteredProject(meta.projectPath)) {
          try {
            rmSync(resolve(latioLayout(meta.projectPath).sessions, meta.id), { recursive: true, force: true });
          } catch {
            /* 清理失败不影响原目录 */
          }
        }
        console.warn(`[piAdapter] 会话迁移失败（保留原目录，下次启动重试）${srcDir}: ${(err as Error).message}`);
      }
    }
  }

  /** 旧目录写迁移完成标记：扫描跳过，副本保留以避免迁移异常造成历史丢失 */
  private markMigrated(srcMetaFile: string, meta: SessionMeta, dstDir: string): void {
    try {
      const tombstone: SessionMeta = { ...meta, migratedTo: dstDir, migratedAt: new Date().toISOString() };
      writeFileSync(srcMetaFile, JSON.stringify(tombstone, null, 2), "utf8");
    } catch (err) {
      console.warn(`[piAdapter] 写迁移标记失败 ${srcMetaFile}: ${(err as Error).message}`);
    }
  }

  /** 扫描单个会话根目录 */
  private scanSessionRoot(sessionsDir: string): void {
    if (!existsSync(sessionsDir)) return;
    for (const name of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const sessionDir = resolve(sessionsDir, name.name);
      const metaFile = resolve(sessionDir, "meta.json");
      if (!existsSync(metaFile)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaFile, "utf8")) as SessionMeta;
        if (!meta?.id || !meta.createdAt) continue;
        // 已迁入项目 .latio 的旧中央会话：这里只留墓碑，项目内副本由项目根扫描注册
        if (meta.migratedTo) continue;
        // 临时会话（创建后从未发送过消息）不恢复：直接清掉目录，避免工作区堆积
        if (meta.draft) {
          try {
            rmSync(sessionDir, { recursive: true, force: true });
          } catch (err) {
            console.warn(`[piAdapter] 清理临时会话失败 ${sessionDir}: ${(err as Error).message}`);
          }
          continue;
        }
        // 权限归一：旧数据里被关掉的读/写/命令行不再生效（界面已无恢复入口）
        const permissions = normalizeSessionPermissions(meta.permissions);
        const entry: SessionEntry = {
          meta: { ...meta, permissions },
          sessionDir,
          status: meta.deletedAt ? "closed" : "idle",
          session: null,
          loader: null,
          subscribers: new Set(),
          blockedCalls: new Set(),
          closing: false,
          nextSeq: readLastSeq(resolve(sessionDir, "logs", "events.jsonl")),
          eventsStream: null,
          controlState: {
            permissions,
            mode: meta.mode ?? "act",
            allowedRoots: this.computeAllowedRoots(meta, sessionDir),
          },
        };
        this.sessions.set(meta.id, entry);
      } catch (err) {
        console.warn(`[piAdapter] 跳过无法解析的会话元数据 ${metaFile}: ${(err as Error).message}`);
      }
    }
  }

  /** 启动只补齐内存顺序；首次修改会话时整批落盘，避免部分旧项仍无序号而在重启后移位。 */
  private normalizeSortOrders(): void {
    const ordered = [...this.sessions.values()].sort(
      (a, b) =>
        (a.meta.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.meta.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
        a.meta.createdAt.localeCompare(b.meta.createdAt) ||
        a.meta.id.localeCompare(b.meta.id)
    );
    ordered.forEach((entry, index) => {
      if (entry.meta.sortOrder !== index) this.sortOrderNeedsPersist = true;
      entry.meta.sortOrder = index;
    });
  }

  /** 允许读写的根目录：cwd + 会话目录下的数据子目录（logs 排除，Agent 不应写日志） */
  private computeAllowedRoots(meta: SessionMeta, sessionDir: string): string[] {
    const roots = [
      meta.cwd,
      resolve(sessionDir, "input"),
      resolve(sessionDir, "output"),
      resolve(sessionDir, "scripts"),
    ];
    return [...new Set(roots)];
  }

  private async getRuntime(): Promise<ModelRuntime> {
    if (!this.modelRuntime) {
      const runtime = await ModelRuntime.create({
        authPath: this.authFile,
        modelsPath: this.modelsFile,
      });
      this.applyRuntimeModelDefaults(runtime);
      this.modelRuntime = runtime;
    }
    return this.modelRuntime;
  }

  /**
   * 模型条目的运行时字段：文件显式值 > 内置系列档案 > 全局默认。
   * 全局默认 = 256k 上下文、支持思考（档位默认全开到 max，选 off 即关闭思考）、纯文本。
   *
   * compat 必须在这里逐模型带上：SDK 的 applyExtension 会用扩展的模型定义整体替换
   * models.json 层（含已合并的 provider 级 compat），不带等于丢弃用户配置。
   * 未显式配置时默认 supportsDeveloperRole=false（发 system）——第三方 OpenAI 兼容
   * 网关普遍不实现 developer 角色；显式写 true 可改回。
   */
  private runtimeModelFields(m: ModelFileEntry, provider?: ProviderFileEntry) {
    const profile = matchModelProfile(m.id);
    const compat: Record<string, unknown> = {
      ...((provider?.compat as Record<string, unknown> | undefined) ?? {}),
      ...((m.compat as Record<string, unknown> | undefined) ?? {}),
    };
    if (compat.supportsDeveloperRole === undefined) compat.supportsDeveloperRole = false;
    return {
      input: (m.input?.length ? [...m.input] : (profile?.input ?? ["text"])) as ("text" | "image")[],
      reasoning: m.reasoning ?? profile?.reasoning ?? true,
      contextWindow: m.contextWindow ?? profile?.contextWindow ?? 256000,
      maxTokens: m.maxTokens ?? 16384,
      // 空对象是显式清除（只保留 off..high），不能被档案默认覆盖
      thinkingLevelMap: m.thinkingLevelMap ?? profile?.thinkingLevelMap ?? { xhigh: "xhigh", max: "max" },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: compat as Model<Api>["compat"],
    };
  }

  /**
   * SDK 直接从 models.json 构建模型对象，缺省字段（reasoning/contextWindow/thinkingLevelMap）
   * 不会自动补齐；启动时按上述优先级重注册一遍，让已有模型立即获得能力兜底。
   * 只影响内存运行时，不写回 models.json。
   */
  private applyRuntimeModelDefaults(runtime: ModelRuntime): void {
    let data;
    try {
      data = readModelsFile(this.modelsFile);
    } catch (err) {
      console.warn(`[piAdapter] models.json 解析失败，跳过模型能力兜底: ${(err as Error).message}`);
      return;
    }
    for (const [providerId, provider] of Object.entries(data.providers)) {
      if (!provider?.baseUrl) continue;
      try {
        runtime.registerProvider(providerId, {
          name: provider.name ?? providerId,
          baseUrl: provider.baseUrl,
          api: (provider.api ?? "openai-completions") as Api,
          models: (provider.models ?? []).map((m) => ({
            id: m.id,
            name: m.name ?? m.id,
            ...this.runtimeModelFields(m, provider),
          })),
        });
      } catch (err) {
        console.warn(`[piAdapter] 提供商 ${providerId} 能力兜底注册失败: ${(err as Error).message}`);
      }
    }
  }

  /** 按权限与模式计算有效工具集（交集过滤 config.agentTools）；
   *  plan 专属工具（submit_plan）由 PLAN_ONLY_TOOLS 编排：plan 注入、act 排除 */
  private effectiveTools(meta: SessionMeta): string[] {
    const perms = meta.permissions;
    const permitted = this.config.agentTools.filter((tool) => {
      if ((tool === "read" || tool === "ls" || tool === "grep" || tool === "find") && perms.read === "off") {
        return false;
      }
      if ((tool === "write" || tool === "edit") && perms.write === "off") return false;
      if (
        (tool === "bash" ||
          tool === "powershell" ||
          isOpenGisToolName(tool) ||
          isMapToolName(tool)) &&
        !perms.bash
      ) {
        return false;
      }
      return true;
    });
    if (meta.mode !== "plan") {
      return permitted.filter((tool) => !PLAN_ONLY_TOOLS.includes(tool));
    }
    const planBase = permitted.filter((tool) => this.config.planTools.includes(tool));
    return [...planBase, ...PLAN_ONLY_TOOLS.filter((t) => !planBase.includes(t))];
  }

  /**
   * 解析会话应使用的模型（尽力而为）：meta.model → 应用默认模型。
   * 仅本地查表，不调用模型 API；未配置任何提供商时返回 undefined，
   * 由 SDK 以"未选模型"模式建会话，发消息时由 assertModelReady 提示。
   */
  private async tryResolveModel(ref?: ModelRef): Promise<Model<Api> | undefined> {
    const target = ref ?? this.resolveDefaultModel();
    if (!target) return undefined;
    const runtime = await this.getRuntime();
    return runtime.getModel(target.providerId, target.modelId);
  }

  /** 严格版：显式指定模型的入口（setModel 等）使用，模型不存在直接报错 */
  private async resolveModel(ref?: ModelRef): Promise<Model<Api>> {
    const target = ref ?? this.resolveDefaultModel();
    if (!target) {
      throw new Error("尚未配置模型提供商：请在“设置 → 模型提供商”中添加提供商并导入模型");
    }
    const model = await this.tryResolveModel(target);
    if (!model) {
      throw new Error(
        `models.json 中未找到模型 ${target.providerId}/${target.modelId}，请检查 server/.pi/models.json`
      );
    }
    return model;
  }

  /**
   * 默认模型解析（新会话未显式指定时）：用户设置（settings.json defaultModel）优先，
   * 否则取 models.json 第一个提供商的第一个模型；未配置任何提供商时返回 null。
   */
  resolveDefaultModel(): ModelRef | null {
    const configured = this.readSettings().defaultModel;
    if (configured) return configured;
    try {
      const data = readModelsFile(this.modelsFile);
      for (const [providerId, entry] of Object.entries(data.providers)) {
        const first = entry.models?.[0];
        if (first?.id) return { providerId, modelId: first.id };
      }
    } catch {
      // models.json 解析失败：视为未配置
    }
    return null;
  }

  async createSession(input?: CreateSessionInput): Promise<AgentSessionInfo> {
    const id = randomUUID();
    let projectPath: string | undefined;
    if (input?.projectPath) {
      projectPath = resolve(input.projectPath);
      if (!isAbsolute(projectPath) || !existsSync(projectPath)) {
        throw new Error(`项目路径不存在或不是绝对路径: ${input.projectPath}`);
      }
    }
    // 注册项目：会话存入项目内 .latio（随项目整体迁移）；否则用中央隔离工作区
    if (projectPath && this.isRegisteredProject(projectPath)) {
      this.ensureProjectLayout(projectPath);
    }
    const sessionDir = this.sessionDirFor(projectPath, id);
    for (const sub of ["input", "working", "output", "logs", "scripts"]) {
      mkdirSync(resolve(sessionDir, sub), { recursive: true });
    }
    const workingDir = resolve(sessionDir, "working");
    const cwd = projectPath ?? workingDir;
    const logsDir = resolve(sessionDir, "logs");

    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id,
      createdAt: now,
      updatedAt: now,
      ...(projectPath ? { projectPath } : {}),
      cwd,
      mode: "act",
      permissions: { ...DEFAULT_SESSION_PERMISSIONS },
      // 新会话固定追加到列表末尾（手动排序体系：顺序只随用户拖动变化）
      sortOrder: this.nextSortOrder(),
      // 临时会话：前端隐藏，首条消息后转正式（见 sendMessage）
      ...(input?.draft ? { draft: true } : {}),
    };
    // 默认模型：用户设置优先，否则首提供商首模型（显式写入 meta，前端/占用条可见）
    const defaultModel = this.resolveDefaultModel();
    if (defaultModel) meta.model = { ...defaultModel };

    const sessionManager = SessionManager.create(cwd, logsDir);
    const entry = await this.buildSession(meta, sessionDir, sessionManager);
    this.setPiFile(meta, sessionDir, sessionManager.getSessionFile());
    this.writeMeta(entry);

    this.emit(entry, makeEvent(id, () => ({ type: "session.started" })));
    return this.toInfo(entry);
  }

  /**
   * 由（新建或从磁盘打开的）SessionManager 构建 AgentSession 并注册。
   * 新建与 lazy 恢复共用；meta.piSessionFile 由调用方在新建后补写。
   */
  private async buildSession(
    meta: SessionMeta,
    sessionDir: string,
    sessionManager: SessionManager
  ): Promise<SessionEntry> {
    // 尽力解析模型：models.json 为空或模型不存在时以"未选模型"模式建会话
    // （不调用任何模型 API），用户在设置页配置模型后切换即可用
    const model = await this.tryResolveModel(meta.model);

    const blockedCalls = new Set<string>();
    const controlState: SessionControlState = {
      permissions: meta.permissions,
      mode: meta.mode,
      allowedRoots: this.computeAllowedRoots(meta, sessionDir),
    };
    // 门控扩展在前（block 优先于审批），todo 在后。
    // skills 与 prompt 模板经 loader 自动发现：全局目录 server/.pi/{skills,prompts}，
    // 项目级 .pi/{skills,prompts} 随会话 cwd 生效；上下文压缩走 SDK 内建
    // （阈值来自应用设置，经 inMemory SettingsManager 注入，不落 Pi 全局配置）。
    const loader = new DefaultResourceLoader({
      cwd: meta.cwd,
      agentDir: resolve(SERVER_DIR, ".pi"),
      noExtensions: true,
      noThemes: true,
      noContextFiles: true,
      // 全局自定义指令（设置页「全局指令」）：追加在内置系统提示词之后（SDK 原生
      // appendSystemPrompt 机制，等价 agentDir/APPEND_SYSTEM.md 但内容存应用设置）。
      // loader 每会话构建一次：新建/重新恢复的会话立即生效，已打开会话在重启后生效。
      ...(this.readSettings().customInstructions?.trim()
        ? { appendSystemPrompt: [this.readSettings().customInstructions!.trim()] }
        : {}),
      // 应用设置中禁用的技能不进入会话（新建/恢复会话均生效）
      skillsOverride: ({ skills, diagnostics }) => {
        const disabled = new Set(this.readSettings().disabledSkills ?? []);
        if (!disabled.size) return { skills, diagnostics };
        return { skills: skills.filter((s) => !disabled.has(s.name)), diagnostics };
      },
      extensionFactories: [
        createPlanModeGuard({ getState: () => controlState, blockedCalls }),
        createPermissionGuard({ getState: () => controlState, blockedCalls }),
        createApprovalGate({
          tools: this.config.approvalTools,
          onRequest: (req) => this.handleApprovalRequest(meta.id, req),
          // 审批策略（permissions.approval）：
          // - ask：全部逐次询问（plan 模式下白名单只读 bash 免审批）
          // - smart：只读命令自动放行（opengis 无法静态判定，仍询问）
          // - full：全部跳过审批（permissions.bash=false 与敏感文件黑名单仍生效）
          skip: (tool, input) => {
            const approval = controlState.permissions.approval ?? "ask";
            if (approval === "full") return true;
            const command = String((input as { command?: unknown })?.command ?? "");
            if (approval === "smart") {
              if (tool === "bash") return isSafeBashCommand(command);
              if (tool === "powershell") return isSafePowerShellCommand(command);
            }
            // plan 模式下白名单内的只读 bash 免审批（planMode 扩展已拦截危险命令；
            // 此处用严格只读判定，不随 Act 的工作区写放宽变化）
            return controlState.mode === "plan" && tool === "bash" && isReadOnlyBashCommand(command);
          },
        }),
        createTodoExtension(),
      ],
    });
    await loader.reload();

    // 压缩阈值以百分比配置，按会话当前模型的上下文窗口换算为绝对 token
    // （快照语义：运行中切模型不重算，重启/重新激活后按新模型窗口生效；
    // 未选模型时按 256000 兜底，切换模型后按新模型窗口生效）
    const { compaction } = this.readSettings();
    const contextWindow = model && model.contextWindow > 0 ? model.contextWindow : 256000;
    const { session } = await createAgentSession({
      cwd: meta.cwd,
      model,
      modelRuntime: await this.getRuntime(),
      // SDK 的 tools 参数同时充当白名单（allowedToolNames，构造后不可变）与初始激活集：
      // 必须传全量（含 PLAN_ONLY_TOOLS），否则 act 模式建立的会话 registry 里没有
      // submit_plan，之后切 plan 时 setActiveToolsByName 会静默忽略该名字
      tools: [...new Set([...this.config.agentTools, ...PLAN_ONLY_TOOLS])],
      customTools: [
        createOpenGisTool(this.config.pythonExecutable, meta.cwd),
        // ArcGIS Pro 自带 Python（arcpy）逃生舱：探测不到安装时传 null，执行时报中文提示
        createArcGisTool(this.config.arcgisPython, meta.cwd, resolve(SERVER_DIR, "python")),
        createMapInspectTool(this.config.pythonExecutable, meta.cwd, {
          sessionId: meta.id,
          store: new MapLayerStore(this.webgisDirFor(meta, sessionDir)),
        }),
        // 地图交互工具：图层清单/新增/调整/移除（受控写入项目 .latio/webgis）
        ...createMapTools({
          sessionId: meta.id,
          store: new MapLayerStore(this.webgisDirFor(meta, sessionDir)),
          pythonExecutable: this.config.pythonExecutable,
          cwd: meta.cwd,
        }),
        // 开源 GIS 数据处理的结构化动作（元信息 / 属性表对齐 / 格式互转 / 别名）
        ...createOpenGisTools({
          pythonExecutable: this.config.pythonExecutable,
          cwd: meta.cwd,
          outputDir: resolve(sessionDir, "output"),
          getState: () => controlState,
        }),
        createSubmitPlanTool(),
        // 结构化提问：execute 内挂起等待用户在前端问卷卡片作答（免审批、plan 可用）
        createAskUserTool({ ask: (questions) => this.handleQuestionRequest(meta.id, questions) }),
      ],
      resourceLoader: loader,
      sessionManager,
      thinkingLevel: meta.thinkingLevel as PiThinkingLevel | undefined,
      settingsManager: SettingsManager.inMemory({
        compaction: {
          enabled: compaction.enabled,
          reserveTokens: percentToTokens(compaction.reservePercent, contextWindow, 2048, 1048576),
          keepRecentTokens: percentToTokens(compaction.keepPercent, contextWindow, 256, 1048576),
        },
      }),
    });
    // 实际启停统一按模式/权限收紧（act 排除 submit_plan，plan 注入）
    session.setActiveToolsByName(this.effectiveTools(meta));
    await session.bindExtensions({ mode: "print" });
    // SDK 可能按模型能力钳制了思考档位（含恢复场景），回写 meta 保持一致
    meta.thinkingLevel = session.thinkingLevel as ThinkingLevel;

    // 恢复场景：复用扫描时已注册的 entry（保留订阅者与 seq），替换会话实例
    const existing = this.sessions.get(meta.id);
    const entry: SessionEntry = existing ?? {
      meta,
      sessionDir,
      status: "idle",
      session: null,
      loader: null,
      subscribers: new Set(),
      blockedCalls: new Set(),
      closing: false,
      nextSeq: 0,
      eventsStream: null,
      controlState,
    };
    if (!existing) this.sessions.set(meta.id, entry);
    entry.session = session;
    entry.loader = loader;
    entry.blockedCalls = blockedCalls;
    entry.controlState = controlState;
    entry.closing = false;
    entry.restoring = undefined;
    this.openEventsStream(entry);
    session.subscribe((event) => this.onSessionEvent(entry, event));
    return entry;
  }

  /**
   * lazy 恢复：从磁盘打开 Pi 会话并重建 AgentSession。
   * 恢复失败标记 unrestorable（历史仍可回放，发消息返回错误）。
   */
  private async ensureActive(entry: SessionEntry): Promise<void> {
    if (entry.session) return;
    if (entry.unrestorable) throw new Error(entry.unrestorable);
    if (entry.meta.deletedAt) throw new Error("会话已在回收站中，请先恢复后再操作");
    if (entry.restoring) return entry.restoring;

    entry.restoring = (async () => {
      try {
        // 项目路径可能在服务停止期间被移动/删除：回退到会话 working 目录
        if (!existsSync(entry.meta.cwd)) {
          entry.meta.cwd = resolve(entry.sessionDir, "working");
          entry.controlState.allowedRoots = this.computeAllowedRoots(entry.meta, entry.sessionDir);
          this.writeMeta(entry);
        }
        const piFile = this.piFileAbs(entry.meta, entry.sessionDir);
        if (!piFile || !existsSync(piFile)) {
          // Pi 会话文件懒落盘：新建后从未发送过消息的会话（如 draft 临时会话）文件
          // 尚未创建，误判为「数据丢失」会让后续发送一直失败（unrestorable 置位后
          // 同进程内不可恢复）。无实质事件的空会话直接重建 Pi 会话（与新建等价，
          // 没有历史可丢）；有事件记录才视为真正的数据缺失。
          if (this.hasTimelineHistory(entry)) {
            throw new Error("该会话缺少 Pi 会话数据，无法继续对话（历史仍可查看）");
          }
          const sessionManager = SessionManager.create(entry.meta.cwd, resolve(entry.sessionDir, "logs"));
          await this.buildSession(entry.meta, entry.sessionDir, sessionManager);
          this.setPiFile(entry.meta, entry.sessionDir, sessionManager.getSessionFile());
          this.writeMeta(entry);
        } else {
          const sessionManager = SessionManager.open(piFile, undefined, entry.meta.cwd);
          await this.buildSession(entry.meta, entry.sessionDir, sessionManager);
        }
      } catch (err) {
        entry.unrestorable = `会话恢复失败: ${(err as Error).message}`;
        entry.restoring = undefined;
        throw err;
      }
      entry.restoring = undefined;
    })();
    return entry.restoring;
  }

  /**
   * events.jsonl 中是否存在实质事件（session.started/updated 之外）：
   * 有则视为有可回放历史（Pi 数据缺失时报错保留语义），无则可安全重建 Pi 会话。
   */
  private hasTimelineHistory(entry: SessionEntry): boolean {
    const file = resolve(entry.sessionDir, "logs", "events.jsonl");
    if (!existsSync(file)) return false;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const type = (JSON.parse(trimmed) as { event?: { type?: string } }).event?.type;
        if (type && type !== "session.started" && type !== "session.updated") return true;
      } catch {
        // 损坏行按有内容处理（保守：宁可报错也不覆盖）
        return true;
      }
    }
    return false;
  }

  async getSession(id: string): Promise<AgentSessionInfo | null> {
    const entry = this.sessions.get(id);
    if (!entry || entry.meta.deletedAt) return null;
    return this.toInfo(entry);
  }

  async listSessions(options?: ListSessionsOptions): Promise<AgentSessionInfo[]> {
    return [...this.sessions.values()]
      .filter((e) => options?.includeDeleted || !e.meta.deletedAt)
      .sort(
        (a, b) =>
          (a.meta.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.meta.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
          a.meta.createdAt.localeCompare(b.meta.createdAt)
      )
      .map((e) => this.toInfo(e));
  }

  /** 手动排序：按入参数组位次重写 sortOrder（拖动排序持久化） */
  async setSessionOrder(orderedIds: string[]): Promise<void> {
    let order = 0;
    for (const id of orderedIds) {
      const entry = this.sessions.get(id);
      if (!entry || entry.meta.deletedAt) continue;
      entry.meta.sortOrder = order++;
      this.touchMeta(entry, false);
    }
  }

  /** 置顶/取消置顶：置顶=sortOrder 提到最前，取消=挪到末尾（pinned 仅作图标标记） */
  async toggleSessionPin(id: string, pinned: boolean): Promise<AgentSessionInfo> {
    const entry = this.requireEntry(id);
    const orders = [...this.sessions.values()]
      .filter((e) => !e.meta.deletedAt && typeof e.meta.sortOrder === "number")
      .map((e) => e.meta.sortOrder as number);
    entry.meta.pinned = pinned;
    entry.meta.sortOrder = orders.length
      ? pinned
        ? Math.min(...orders) - 1
        : Math.max(...orders) + 1
      : 0;
    this.touchMeta(entry, false);
    return this.toInfo(entry);
  }

  /** 非回收站会话的最大排序号 + 1（新建会话追加到末尾用） */
  private nextSortOrder(): number {
    let max = -1;
    for (const e of this.sessions.values()) {
      if (!e.meta.deletedAt && typeof e.meta.sortOrder === "number") max = Math.max(max, e.meta.sortOrder);
    }
    return max + 1;
  }

  async renameSession(id: string, title: string): Promise<AgentSessionInfo> {
    const entry = this.requireEntry(id);
    entry.meta.title = title;
    this.touchMeta(entry);
    return this.toInfo(entry);
  }

  async deleteSession(id: string): Promise<void> {
    const entry = this.requireEntry(id);
    this.teardownSession(entry);
    entry.meta.deletedAt = new Date().toISOString();
    entry.status = "closed";
    this.writeMeta(entry);
  }

  async restoreSession(id: string): Promise<AgentSessionInfo> {
    const entry = this.requireEntry(id);
    delete entry.meta.deletedAt;
    entry.status = "idle";
    this.touchMeta(entry);
    return this.toInfo(entry);
  }

  async purgeSession(id: string): Promise<void> {
    const entry = this.requireEntry(id);
    this.teardownSession(entry);
    rmSync(entry.sessionDir, { recursive: true, force: true });
    this.sessions.delete(id);
  }

  async setMode(id: string, mode: AgentSessionMode): Promise<AgentSessionInfo> {
    const entry = this.requireEntry(id);
    if (entry.meta.deletedAt) throw new Error("会话已在回收站中");
    const previousMode = entry.meta.mode;
    entry.meta.mode = mode;
    entry.controlState.mode = mode;
    await this.ensureActive(entry);
    entry.session?.setActiveToolsByName(this.effectiveTools(entry.meta));
    // plan→act 需主动告知 LLM 规划期结束：plan 轮的对话历史会让模型
    // 继续"自我认知"为规划模式而拒绝执行（官方 plan-mode 同样靠注入切换消息）
    if (previousMode === "plan" && mode === "act" && entry.session) {
      await entry.session.sendCustomMessage(
        {
          customType: "giser-mode-change",
          content:
            "[EXECUTION MODE ACTIVE] 规划模式已结束，写工具与执行权限已恢复。" +
            "用户要求执行计划时，请按已确认的计划逐步执行，不要再次拒绝或重新调研。",
          display: false,
        },
        { triggerTurn: false, deliverAs: "nextTurn" }
      );
    }
    this.touchMeta(entry);
    return this.toInfo(entry);
  }

  async setPermissions(id: string, permissions: SessionPermissions): Promise<AgentSessionInfo> {
    const entry = this.requireEntry(id);
    if (entry.meta.deletedAt) throw new Error("会话已在回收站中");
    entry.meta.permissions = normalizeSessionPermissions(permissions);
    entry.controlState.permissions = entry.meta.permissions;
    await this.ensureActive(entry);
    entry.session?.setActiveToolsByName(this.effectiveTools(entry.meta));
    this.touchMeta(entry);
    return this.toInfo(entry);
  }

  /** 未声明密钥的自定义网关可免鉴权；声明了密钥来源时必须能解析出凭据。 */
  private async assertModelReady(entry: SessionEntry): Promise<void> {
    const model = entry.session?.model;
    if (!model) {
      throw new Error(
        "当前会话尚未选择可用模型：请在设置页添加模型提供商并导入模型，然后在本会话切换模型后再发送消息。"
      );
    }
    const runtime = await this.getRuntime();
    const provider = runtime.getProvider(model.provider);
    // provider 未声明任何鉴权方式（apiKey/oauth 均缺省）：无需凭据，直接放行
    if (!provider || (!provider.auth.apiKey && !provider.auth.oauth)) return;
    let check: AuthCheck | undefined;
    try {
      check = await runtime.checkAuth(model.provider);
    } catch (err) {
      throw new Error(`检查模型凭据失败（${model.provider}）: ${(err as Error).message}`);
    }
    if (check) return;
    const configured = readModelsFile(this.modelsFile).providers[model.provider];
    if (configured && !configured.apiKey?.trim()) return;
    throw new Error(
      `模型提供商「${provider.name}」尚未配置访问凭据，请在“设置 → 模型提供商”中填写 API Key 后重试。`
    );
  }

  async sendMessage(id: string, text: string, images?: UserMessageImage[]): Promise<number> {
    const entry = this.requireEntry(id);
    if (entry.meta.deletedAt) throw new Error("会话已在回收站中，无法发送消息");
    await this.ensureActive(entry);
    // 发送前确认当前模型与凭据可用（未配置时给出中文提示，而非 SDK 的英文报错）
    await this.assertModelReady(entry);
    // 临时会话在首条用户消息后转为正式会话（进入列表）；
    // 与「首条消息自动命名」合并为一次落盘 + 一条 session.updated，前端据此立即显示
    let metaChanged = false;
    if (entry.meta.draft) {
      delete entry.meta.draft;
      metaChanged = true;
    }
    // 首条消息自动命名（可被 renameSession 覆盖）
    if (!entry.meta.title) {
      const auto = text.trim().replace(/\s+/g, " ").slice(0, 24);
      if (auto) {
        entry.meta.title = auto;
        metaChanged = true;
      }
    }
    if (metaChanged) {
      this.touchMeta(entry, false);
      this.emit(
        entry,
        makeEvent(id, () => ({ type: "session.updated", session: this.toInfo(entry) }))
      );
    }
    entry.status = "running";
    // 图片压缩后进入模型与事件流（回放与发给模型的内容一致）
    const attachments = images?.length ? await this.prepareImages(images) : undefined;
    // 用户消息先落盘（历史回放重建时间线；live 端前端已本地渲染并按内容去重）
    const userSeq = this.emit(
      entry,
      makeEvent(id, () => ({
        type: "user.message",
        text,
        ...(attachments?.length ? { images: attachments } : {}),
      }))
    );
    // prompt 默认展开 slash 命令（/模板名、/skill:名），因此命令与普通消息同通道
    void entry
      .session!.prompt(text, {
        ...(attachments?.length
          ? { images: attachments.map((img) => ({ type: "image" as const, ...img })) }
          : {}),
      })
      .catch((err: unknown) => {
        this.emit(
          entry,
          makeEvent(id, () => ({
            type: "agent.error",
            error: describePromptError(err, entry.session?.model?.id),
          }))
        );
      });
    return userSeq;
  }

  /**
   * 编辑历史用户消息并原地重发：把 SDK 会话回退到该消息之前（navigateTree
   * 会把 leaf 移到其 parent 并重建上下文），截断其后的事件轨迹，再以新文本重发。
   * 被替换的轨迹在 SDK 会话树中仍保留，事件尾部另存 logs/events.replaced-*.jsonl 备份。
   */
  async editAndResend(id: string, fromSeq: number, text: string): Promise<number> {
    const entry = this.requireEntry(id);
    if (entry.meta.deletedAt) throw new Error("会话已在回收站中，无法编辑消息");
    if (entry.status === "running") throw new Error("会话正在运行，请先停止后再编辑历史消息");
    await this.ensureActive(entry);
    // 先校验模型与凭据：不满足时直接报错，避免破坏已有历史
    await this.assertModelReady(entry);

    const eventsFile = resolve(entry.sessionDir, "logs", "events.jsonl");
    const target = findUserMessage(eventsFile, fromSeq);
    if (!target) throw new Error(`seq=${fromSeq} 不是一条用户消息，无法编辑`);

    const { messageEntries, userPos } = this.locatePiUserEntry(
      entry.meta,
      entry.sessionDir,
      target.userIndex
    );
    const targetEntryId = messageEntries[userPos]?.id;
    if (!targetEntryId) throw new Error("Pi 会话数据中未找到对应消息，无法编辑");

    // SDK 侧回退（不删除历史，只在树内把 leaf 移到该消息之前）
    await entry.session!.navigateTree(targetEntryId);

    // 事件轨迹截断到该消息之前，seq 从该消息处重新分配
    await this.closeEventsStream(entry);
    truncateEventsBefore(eventsFile, fromSeq);
    entry.nextSeq = fromSeq;
    this.openEventsStream(entry);

    // 沿用原消息的图片附件重新发送
    return this.sendMessage(id, text, target.images);
  }

  /** 图片入模前压缩（控制 events.jsonl 落盘与请求体积；不支持Resize的格式原样透传） */
  private async prepareImages(images: UserMessageImage[]): Promise<UserMessageImage[]> {
    const result: UserMessageImage[] = [];
    for (const img of images) {
      try {
        const bytes = new Uint8Array(Buffer.from(img.data, "base64"));
        const resized = await resizeImage(bytes, img.mimeType, { maxBytes: 1_500_000 });
        result.push(resized ? { mimeType: resized.mimeType, data: resized.data } : img);
      } catch {
        // 压缩失败不阻塞发送，原样透传由模型侧决定
        result.push(img);
      }
    }
    return result;
  }

  async cancel(id: string): Promise<void> {
    const entry = this.requireEntry(id);
    // 先把该会话的待审批/待答提问全部收敛，避免 Agent 在挂起中无法退出
    this.resolvePending(id, false);
    this.resolvePendingQuestions(id);
    await entry.session?.abort();
  }

  async approve(id: string, requestId: string, approved: boolean): Promise<void> {
    const entry = this.requireEntry(id);
    const pending = this.pendingApprovals.get(requestId);
    if (pending && pending.sessionId === id) {
      pending.resolve(approved);
      return;
    }
    // pending 不在内存（服务重启 / 已超时自动拒绝 / 已处理）：按落盘事件幂等收敛——
    // 已有 resolved → 直接成功；仅有 required → 补落 resolved 让 UI 收敛为终态
    const file = resolve(entry.sessionDir, "logs", "events.jsonl");
    let sawRequired = false;
    let sawResolved = false;
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as { event?: { type?: string; request_id?: string } };
          const ev = rec.event;
          if (ev?.request_id !== requestId) continue;
          if (ev.type === "approval.required") sawRequired = true;
          if (ev.type === "approval.resolved") sawResolved = true;
        } catch {
          // 跳过损坏行
        }
      }
    }
    if (sawResolved) return;
    if (sawRequired) {
      this.emit(
        entry,
        makeEvent(id, () => ({ type: "approval.resolved", request_id: requestId, approved }))
      );
      return;
    }
    throw new Error(`审批请求不存在或已处理: ${requestId}`);
  }

  /** 回传用户对 ask_user 提问的作答（幂等语义对齐 approve） */
  async answerQuestion(id: string, requestId: string, payload: AskUserResult): Promise<void> {
    const entry = this.requireEntry(id);
    const pending = this.pendingQuestions.get(requestId);
    if (pending && pending.sessionId === id) {
      pending.resolve(payload);
      return;
    }
    // pending 不在内存（服务重启 / 已超时 / 已处理）：按落盘事件幂等收敛——
    // 已有 answered → 直接成功；仅有 required → 补落终态让 UI 收敛
    const file = resolve(entry.sessionDir, "logs", "events.jsonl");
    let sawRequired = false;
    let sawAnswered = false;
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as { event?: { type?: string; request_id?: string } };
          const ev = rec.event;
          if (ev?.request_id !== requestId) continue;
          if (ev.type === "question.required") sawRequired = true;
          if (ev.type === "question.answered") sawAnswered = true;
        } catch {
          // 跳过损坏行
        }
      }
    }
    if (sawAnswered) return;
    if (sawRequired) {
      this.emit(
        entry,
        makeEvent(id, () => ({
          type: "question.answered",
          request_id: requestId,
          ...(payload.answers ? { answers: payload.answers } : {}),
          ...(payload.cancelled ? { cancelled: true } : {}),
          ...(payload.timeout ? { timeout: true } : {}),
        }))
      );
      return;
    }
    throw new Error(`提问请求不存在或已处理: ${requestId}`);
  }

  subscribeEvents(id: string, cb: (event: AgentEvent) => void): () => void {
    const entry = this.requireEntry(id);
    entry.subscribers.add(cb);
    // 订阅即触达：lazy 恢复（失败只记录，订阅本身不受影响，历史回放仍可用）
    void this.ensureActive(entry).catch((err) => {
      console.warn(`[piAdapter] 会话 ${id} 恢复失败: ${(err as Error).message}`);
    });
    return () => entry.subscribers.delete(cb);
  }

  async history(id: string, afterSeq = 0): Promise<AgentHistoryRecord[]> {
    const entry = this.requireEntry(id);
    const file = resolve(entry.sessionDir, "logs", "events.jsonl");
    if (!existsSync(file)) return [];
    const records: AgentHistoryRecord[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as AgentHistoryRecord;
        if (typeof rec.seq === "number" && rec.seq > afterSeq) records.push(rec);
      } catch {
        // 跳过损坏行（半写入等）
      }
    }
    return records;
  }

  async listModels(): Promise<AvailableModel[]> {
    const runtime = await this.getRuntime();
    const models = await runtime.getAvailable();
    return models.map((m) => ({
      providerId: String(m.provider),
      modelId: m.id,
      name: m.name ?? m.id,
      input: [...(m.input ?? ["text"])],
      contextWindow: m.contextWindow ?? 0,
      maxTokens: m.maxTokens ?? 0,
      reasoning: Boolean(m.reasoning),
      thinkingLevels: getSupportedThinkingLevels(m) as ThinkingLevel[],
      ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
    }));
  }

  async setModel(id: string, model: ModelRef): Promise<AgentSessionInfo> {
    const entry = this.requireEntry(id);
    if (entry.meta.deletedAt) throw new Error("会话已在回收站中");
    await this.ensureActive(entry);
    const target = await this.resolveModel(model);
    // persist:false —— 多会话共享运行时，不写 Pi 全局配置；会话级选择记入 meta
    await entry.session!.setModel(target, { persist: false });
    entry.meta.model = { ...model };
    // SDK 切模型时按新模型能力钳制思考档位，回读保持 meta 一致
    entry.meta.thinkingLevel = entry.session!.thinkingLevel as ThinkingLevel;
    this.touchMeta(entry);
    return this.toInfo(entry);
  }

  async setThinkingLevel(id: string, level: ThinkingLevel): Promise<AgentSessionInfo> {
    const entry = this.requireEntry(id);
    if (entry.meta.deletedAt) throw new Error("会话已在回收站中");
    await this.ensureActive(entry);
    // SDK 参数类型不含 off（运行时支持，非推理模型唯一可用档就是 off）
    entry.session!.setThinkingLevel(level as PiThinkingLevel, { persist: false });
    entry.meta.thinkingLevel = entry.session!.thinkingLevel as ThinkingLevel;
    this.touchMeta(entry);
    return this.toInfo(entry);
  }

  async getContext(id: string): Promise<SessionContextInfo> {
    const entry = this.requireEntry(id);
    await this.ensureActive(entry);
    const session = entry.session!;

    const usage = session.getContextUsage();
    // 系统提示词按段拆分（参考 DeepSeek Harness 的 section 组装理念）：
    // 技能是固定标记的 <available_skills> 块，可从全文精确提取，剩余即纯系统提示词
    const systemPromptText = session.systemPrompt ?? "";
    const skillsBlock = systemPromptText.match(
      /<available_skills>[\s\S]*?<\/available_skills>/
    )?.[0];
    const skillsTokens = skillsBlock ? estimateTextTokens(skillsBlock) : 0;
    const breakdown: SessionContextInfo["breakdown"] = {
      messages: 0,
      tools: session
        .getAllTools()
        .reduce((sum, info) => {
          const def = session.getToolDefinition(info.name);
          return sum + estimateTextTokens(JSON.stringify(def ?? info));
        }, 0),
      systemPrompt: Math.max(0, estimateTextTokens(systemPromptText) - skillsTokens),
      skills: skillsTokens,
      // 其他：图片（SDK 同款 4800 字符/图 ≈ 1200 token 近似）等非文本成分
      other: 0,
    };
    // 历史消息：当前分支逐条按角色累计（合并入 messages）
    const branch = session.sessionManager.getBranch() as Array<{
      type?: string;
      message?: { role?: string; content?: unknown };
    }>;
    for (const e of branch) {
      if (e.type !== "message" || !e.message?.content) continue;
      const content = e.message.content as Array<{ type?: string; text?: string }>;
      if (e.message.role === "user") {
        for (const block of content) {
          if (block.type === "image") breakdown.other += 1200;
          else breakdown.messages += estimateTextTokens(block.text ?? "");
        }
      } else if (e.message.role === "assistant" || e.message.role === "toolResult") {
        breakdown.messages += estimateMessageTokens(e.message as Parameters<typeof estimateMessageTokens>[0]);
      }
    }

    // 最近一轮账单（LLM 上报；getBranch 尾部找最后一条有效 assistant usage）
    let lastUsage: SessionContextInfo["lastUsage"];
    for (let i = branch.length - 1; i >= 0; i--) {
      const m = branch[i].message as
        | { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; totalTokens?: number; cost?: { input?: number; output?: number; total?: number } } }
        | undefined;
      if (m?.role === "assistant" && typeof m.usage?.input === "number") {
        lastUsage = {
          input: m.usage.input,
          output: m.usage.output ?? 0,
          cacheRead: m.usage.cacheRead ?? 0,
          cacheWrite: m.usage.cacheWrite ?? 0,
          ...(typeof m.usage.reasoning === "number" ? { reasoning: m.usage.reasoning } : {}),
          totalTokens: m.usage.totalTokens ?? (m.usage.input + (m.usage.output ?? 0)),
          cost: {
            input: m.usage.cost?.input ?? 0,
            output: m.usage.cost?.output ?? 0,
            total: m.usage.cost?.total ?? 0,
          },
        };
        break;
      }
    }

    return {
      total: {
        // 0 视同 null（空会话 SDK 返回 0，无真实响应数据）
        tokens: usage?.tokens ? usage.tokens : null,
        contextWindow: usage?.contextWindow ?? 0,
        percent: usage?.tokens ? (usage.percent ?? null) : null,
      },
      breakdown,
      ...(lastUsage ? { lastUsage } : {}),
    };
  }

  async listProviders(): Promise<ProviderSummary[]> {
    const modelsData = readModelsFile(this.modelsFile);
    const authData = readAuthFile(this.authFile);
    return Object.entries(modelsData.providers).map(([id, entry]) => ({
      id,
      name: entry.name ?? id,
      baseUrl: entry.baseUrl ?? "",
      api: entry.api ?? "openai-completions",
      modelCount: entry.models?.length ?? 0,
      hasStoredKey: Boolean(authData[id]?.key),
    }));
  }

  async addProvider(input: { id: string; name?: string; baseUrl: string; api?: string; apiKey?: string }): Promise<ProviderSummary> {
    const id = input.id.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
      throw new Error("provider id 仅允许字母数字与中划线/下划线，且以字母数字开头");
    }
    if (!/^https?:\/\//.test(input.baseUrl.trim())) {
      throw new Error("baseUrl 需为 http(s) 地址");
    }
    const runtime = await this.getRuntime();
    if (runtime.getProviders().some((p) => p.id === id)) {
      throw new Error(`provider 已存在: ${id}`);
    }
    const api = input.api?.trim() || "openai-completions";

    // 先内存注册（已激活会话立即可见；registerProvider 校验时磁盘尚无同名条目），
    // 随后落盘 models.json（不含密钥）与 auth.json（真实密钥，重启后优先于 models.json）
    runtime.registerProvider(id, {
      name: input.name?.trim() || id,
      baseUrl: input.baseUrl.trim(),
      api: api as Api,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    });
    const modelsData = readModelsFile(this.modelsFile);
    modelsData.providers[id] = {
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      baseUrl: input.baseUrl.trim(),
      api,
    };
    writeModelsFile(this.modelsFile, modelsData);
    if (input.apiKey) {
      const authData = readAuthFile(this.authFile);
      authData[id] = { type: "api_key", key: input.apiKey };
      writeAuthFile(this.authFile, authData);
    }
    return {
      id,
      name: input.name?.trim() || id,
      baseUrl: input.baseUrl.trim(),
      api,
      modelCount: 0,
      hasStoredKey: Boolean(input.apiKey),
    };
  }

  /** auth.json 中已保存的提供商密钥（上游探测等内部用途；不进入任何 API 响应） */
  getStoredApiKey(providerId: string): string | undefined {
    return readAuthFile(this.authFile)[providerId]?.key;
  }

  /**
   * 删除提供商：仅「正在运行且使用该 provider」的会话阻止删除；
   * 其余会话在删除后自动切回剩余默认模型（无可用 provider 时置空引用，
   * 发消息时由 assertModelReady 给出配置提示）。
   */
  async removeProvider(id: string): Promise<void> {
    const running = [...this.sessions.values()].find(
      (e) => e.status === "running" && !e.meta.deletedAt && e.meta.model?.providerId === id
    );
    if (running) {
      throw new Error(
        `会话「${running.meta.title ?? running.meta.id.slice(0, 8)}」正在运行并使用该 provider，请先停止或切换其模型`
      );
    }
    const modelsData = readModelsFile(this.modelsFile);
    if (!modelsData.providers[id]) throw new Error(`provider 不存在: ${id}`);
    const runtime = await this.getRuntime();
    runtime.unregisterProvider(id);
    delete modelsData.providers[id];
    writeModelsFile(this.modelsFile, modelsData);
    const authData = readAuthFile(this.authFile);
    delete authData[id];
    writeAuthFile(this.authFile, authData);

    // 引用清理：闲置/已激活会话切到剩余默认模型（settings.defaultModel 已由路由层先行清理失效值）
    const fallback = this.resolveDefaultModel();
    const fallbackModel =
      fallback ? runtime.getModel(fallback.providerId, fallback.modelId) : undefined;
    for (const entry of this.sessions.values()) {
      if (entry.meta.deletedAt || entry.meta.model?.providerId !== id) continue;
      entry.meta.model = fallbackModel && fallback ? fallback : undefined;
      if (entry.session && fallbackModel) {
        try {
          await entry.session.setModel(fallbackModel, { persist: false });
          entry.meta.thinkingLevel = entry.session.thinkingLevel as PiThinkingLevel;
        } catch (err) {
          console.warn(`[piAdapter] 删除 provider 后切换会话 ${entry.meta.id} 的模型失败: ${(err as Error).message}`);
        }
      }
      this.touchMeta(entry);
    }
  }

  async importModels(providerId: string, models: ImportModelInput[]): Promise<ProviderSummary> {
    const modelsData = readModelsFile(this.modelsFile);
    const provider = modelsData.providers[providerId];
    if (!provider) throw new Error(`provider 不存在: ${providerId}`);
    const clean = models.filter((m) => typeof m?.id === "string" && m.id.trim());
    if (!clean.length) throw new Error("models 不能为空");

    const existing = provider.models ?? [];
    const byId = new Map(existing.map((m) => [m.id, m]));
    for (const m of clean) {
      const id = m.id.trim();
      byId.set(id, {
        ...byId.get(id),
        id,
        ...(m.name?.trim() ? { name: m.name.trim() } : byId.get(id)?.name ? {} : { name: id }),
        input: m.input?.length ? [...m.input] : byId.get(id)?.input,
        ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
        ...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
        ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
        // 空对象表示清除扩展档位（xhigh/max）：置 undefined 后写盘时被 JSON 序列化省略
        ...(m.thinkingLevelMap !== undefined
          ? { thinkingLevelMap: Object.keys(m.thinkingLevelMap).length ? m.thinkingLevelMap : undefined }
          : {}),
      });
    }
    provider.models = [...byId.values()];
    writeModelsFile(this.modelsFile, modelsData);

    // 重新内存注册完整 provider（合并语义：本次 models 覆盖上次注册）
    const runtime = await this.getRuntime();
    runtime.registerProvider(providerId, {
      name: provider.name ?? providerId,
      baseUrl: provider.baseUrl,
      api: (provider.api ?? "openai-completions") as Api,
      models: provider.models.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        ...this.runtimeModelFields(m, provider),
      })),
    });
    // 模型元数据（reasoning/contextWindow 等）变更后，刷新使用该 provider 的已激活会话
    await this.refreshSessionsForProvider(providerId);

    const authData = readAuthFile(this.authFile);
    return {
      id: providerId,
      name: provider.name ?? providerId,
      baseUrl: provider.baseUrl ?? "",
      api: provider.api ?? "openai-completions",
      modelCount: provider.models.length,
      hasStoredKey: Boolean(authData[providerId]?.key),
    };
  }

  /**
   * provider 的模型定义变化后，重新解析并更新使用该 provider 的已激活会话。
   * SDK 会话持有构建时的模型对象（含 reasoning/contextWindow），不刷新会继续按
   * 旧值钳制思考档位；运行中的会话不打断，等本轮结束后由用户重新选择模型。
   */
  private async refreshSessionsForProvider(providerId: string): Promise<void> {
    const runtime = await this.getRuntime();
    for (const entry of this.sessions.values()) {
      if (entry.meta.deletedAt || !entry.session) continue;
      const ref = entry.meta.model;
      if (!ref || ref.providerId !== providerId) continue;
      if (entry.status === "running") continue;
      const model = runtime.getModel(ref.providerId, ref.modelId);
      if (!model) continue;
      try {
        await entry.session.setModel(model, { persist: false });
        entry.meta.thinkingLevel = entry.session.thinkingLevel as ThinkingLevel;
        this.touchMeta(entry);
      } catch (err) {
        console.warn(`[piAdapter] 刷新会话 ${entry.meta.id} 的模型失败: ${(err as Error).message}`);
      }
    }
  }

  /** 编辑已有 provider（名称/BaseURL/密钥；密钥仅在填写时覆盖 auth.json） */
  async updateProvider(
    id: string,
    input: { name?: string; baseUrl?: string; apiKey?: string }
  ): Promise<ProviderSummary> {
    const modelsData = readModelsFile(this.modelsFile);
    const provider = modelsData.providers[id];
    if (!provider) throw new Error(`provider 不存在: ${id}`);
    if (input.baseUrl !== undefined) {
      if (!/^https?:\/\//.test(input.baseUrl.trim())) {
        throw new Error("baseUrl 需为 http(s) 地址");
      }
      provider.baseUrl = input.baseUrl.trim();
    }
    if (input.name !== undefined) {
      if (input.name.trim()) provider.name = input.name.trim();
      else delete provider.name;
    }
    writeModelsFile(this.modelsFile, modelsData);
    if (input.apiKey) {
      const authData = readAuthFile(this.authFile);
      authData[id] = { type: "api_key", key: input.apiKey };
      writeAuthFile(this.authFile, authData);
    }

    // baseUrl/名称变更需重注册运行时（密钥从 auth.json 读取，SDK 优先级 auth > models）
    const runtime = await this.getRuntime();
    runtime.registerProvider(id, {
      name: provider.name ?? id,
      baseUrl: provider.baseUrl,
      api: (provider.api ?? "openai-completions") as Api,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      models: (provider.models ?? []).map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        ...this.runtimeModelFields(m, provider),
      })),
    });

    // baseUrl/模型定义变更后刷新使用该 provider 的已激活会话
    await this.refreshSessionsForProvider(id);

    const authData = readAuthFile(this.authFile);
    return {
      id,
      name: provider.name ?? id,
      baseUrl: provider.baseUrl ?? "",
      api: provider.api ?? "openai-completions",
      modelCount: provider.models?.length ?? 0,
      hasStoredKey: Boolean(authData[id]?.key),
    };
  }

  /** 删除 provider 下指定模型（models.json 移除 + 运行时重注册） */
  async removeModels(providerId: string, modelIds: string[]): Promise<ProviderSummary> {
    const modelsData = readModelsFile(this.modelsFile);
    const provider = modelsData.providers[providerId];
    if (!provider) throw new Error(`provider 不存在: ${providerId}`);
    const remove = new Set(modelIds.filter((m) => typeof m === "string" && m.trim()));
    if (!remove.size) throw new Error("modelIds 不能为空");
    const before = provider.models?.length ?? 0;
    provider.models = (provider.models ?? []).filter((m) => !remove.has(m.id));
    if (provider.models.length === before) {
      throw new Error("未匹配到可删除的模型（可能已不存在）");
    }
    writeModelsFile(this.modelsFile, modelsData);

    const runtime = await this.getRuntime();
    runtime.registerProvider(providerId, {
      name: provider.name ?? providerId,
      baseUrl: provider.baseUrl,
      api: (provider.api ?? "openai-completions") as Api,
      models: provider.models.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        ...this.runtimeModelFields(m, provider),
      })),
    });

    const authData = readAuthFile(this.authFile);
    return {
      id: providerId,
      name: provider.name ?? providerId,
      baseUrl: provider.baseUrl ?? "",
      api: provider.api ?? "openai-completions",
      modelCount: provider.models.length,
      hasStoredKey: Boolean(authData[providerId]?.key),
    };
  }

  async compactSession(id: string, instructions?: string): Promise<void> {
    const entry = this.requireEntry(id);
    if (entry.meta.deletedAt) throw new Error("会话已在回收站中");
    await this.ensureActive(entry);
    await entry.session!.compact(instructions?.trim() || undefined);
  }

  /**
   * 定位 Pi 会话中第 userIndex 条用户消息（1-based）：返回打开的 SessionManager、
   * 同一 message 序列（user/assistant）及该消息在序列中的位置。
   * 分支取该轮末尾 leaf，编辑重发则回退到该消息之前。
   */
  private locatePiUserEntry(
    meta: SessionMeta,
    sessionDir: string,
    userIndex: number
  ): {
    manager: SessionManager;
    messageEntries: Array<{ id?: string; message?: { role?: string } }>;
    userPos: number;
  } {
    const piFile = this.piFileAbs(meta, sessionDir);
    if (!piFile || !existsSync(piFile)) {
      throw new Error("该会话缺少 Pi 会话数据，无法定位历史消息");
    }
    const manager = SessionManager.open(piFile, undefined, meta.cwd);
    const all = manager.getEntries() as Array<{
      type?: string;
      id?: string;
      message?: { role?: string };
    }>;
    const messageEntries = all.filter(
      (e) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant")
    );
    let seen = 0;
    let userPos = -1;
    for (let i = 0; i < messageEntries.length; i++) {
      if (messageEntries[i].message?.role !== "user") continue;
      seen += 1;
      if (seen === userIndex) {
        userPos = i;
        break;
      }
    }
    if (userPos < 0) throw new Error("Pi 会话数据中未找到对应轮次");
    return { manager, messageEntries, userPos };
  }

  async branchSession(id: string, fromSeq: number): Promise<AgentSessionInfo> {
    const source = this.requireEntry(id);
    if (source.meta.deletedAt) throw new Error("会话已在回收站中，无法分支");
    // fromSeq 必须落在一条用户消息上（用于 pi 侧 entry 定位）
    const eventsFile = resolve(source.sessionDir, "logs", "events.jsonl");
    const target = findUserMessage(eventsFile, fromSeq);
    if (!target) throw new Error(`seq=${fromSeq} 不是一条用户消息，无法从此处分支`);

    // pi 侧定位：第 userIndex 个 user message entry，其后到下一个 user
    // message 前的最后一个 entry 为该轮 leaf（即该轮 assistant 回复完成处）
    const { manager: piManager, messageEntries, userPos } = this.locatePiUserEntry(
      source.meta,
      source.sessionDir,
      target.userIndex
    );
    const start = messageEntries[userPos];
    if (!start) throw new Error("Pi 会话数据中未找到对应轮次，无法分支");
    let leaf = start;
    for (let i = userPos + 1; i < messageEntries.length; i++) {
      if (messageEntries[i].message?.role === "user") break;
      leaf = messageEntries[i];
    }
    const newPiFile = piManager.createBranchedSession(leaf.id ?? "");
    if (!newPiFile) throw new Error("生成分支会话文件失败");

    // 新会话目录：继承项目/模式/权限/模型，cwd 指向项目或新会话 working
    const newId = randomUUID();
    const sessionDir = this.sessionDirFor(source.meta.projectPath, newId);
    for (const sub of ["input", "working", "output", "logs", "scripts"]) {
      mkdirSync(resolve(sessionDir, sub), { recursive: true });
    }
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: newId,
      createdAt: now,
      updatedAt: now,
      title: `${source.meta.title ?? "会话"} (分支)`,
      ...(source.meta.projectPath ? { projectPath: source.meta.projectPath } : {}),
      cwd: source.meta.projectPath ?? resolve(sessionDir, "working"),
      mode: source.meta.mode,
      permissions: { ...source.meta.permissions },
      // 分支会话按新建语义追加到列表末尾
      sortOrder: this.nextSortOrder(),
      ...(source.meta.model ? { model: { ...source.meta.model } } : {}),
      ...(source.meta.thinkingLevel ? { thinkingLevel: source.meta.thinkingLevel } : {}),
      parentSessionId: source.meta.id,
    };
    // 分支文件由 SDK 落在源会话 logs 下（在新会话目录之外时回落绝对路径）
    this.setPiFile(meta, sessionDir, newPiFile);

    // 复制分支点之前的事件轨迹（seq 原样保留，回放即原时间线前缀）
    const newEventsFile = resolve(sessionDir, "logs", "events.jsonl");
    if (existsSync(eventsFile)) {
      const kept: string[] = [];
      for (const line of readFileSync(eventsFile, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as { seq?: number };
          if (typeof rec.seq === "number" && rec.seq <= fromSeq) kept.push(trimmed);
        } catch {
          // 跳过损坏行
        }
      }
      if (kept.length) writeFileSync(newEventsFile, kept.map((l) => `${l}\n`).join(""), "utf8");
    }

    const entry = await this.buildSession(meta, sessionDir, SessionManager.open(newPiFile, undefined, meta.cwd));
    this.writeMeta(entry);
    this.emit(entry, makeEvent(newId, () => ({ type: "session.started" })));
    return this.toInfo(entry);
  }

  async listCommands(id: string): Promise<SessionCommand[]> {
    const entry = this.requireEntry(id);
    await this.ensureActive(entry);
    const loader = entry.loader;
    if (!loader) return [];
    const commands: SessionCommand[] = [];
    for (const tpl of loader.getPrompts().prompts) {
      commands.push({
        name: `/${tpl.name}`,
        description: tpl.description,
        source: "prompt",
      });
    }
    for (const skill of loader.getSkills().skills) {
      commands.push({
        name: `/skill:${skill.name}`,
        description: skill.description,
        source: "skill",
      });
    }
    return commands;
  }

  async listSkills(id: string): Promise<SessionSkill[]> {
    const entry = this.requireEntry(id);
    await this.ensureActive(entry);
    const loader = entry.loader;
    if (!loader) return [];
    return loader.getSkills().skills.map((s) => ({
      name: s.name,
      description: s.description,
      path: s.filePath,
      scope: s.sourceInfo?.scope === "project" ? "project" : "user",
      disableModelInvocation: Boolean(s.disableModelInvocation),
    }));
  }

  /** 全局技能根目录（应用级 server/.pi/skills 与用户级 ~/.agents/skills） */
  private globalSkillRoots(): Array<{ scope: "app" | "user"; dir: string }> {
    return [
      { scope: "app", dir: resolve(SERVER_DIR, ".pi", "skills") },
      { scope: "user", dir: resolve(homedir(), ".agents", "skills") },
    ];
  }

  /** 扫描全局技能目录（SKILL.md frontmatter 的 name/description），供设置页管理 */
  async listGlobalSkills(): Promise<Array<{ name: string; description: string; path: string; scope: "app" | "user"; enabled: boolean }>> {
    const disabled = new Set(this.readSettings().disabledSkills ?? []);
    const result: Array<{ name: string; description: string; path: string; scope: "app" | "user"; enabled: boolean }> = [];
    for (const root of this.globalSkillRoots()) {
      if (!existsSync(root.dir)) continue;
      for (const ent of readdirSync(root.dir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const skillDir = resolve(root.dir, ent.name);
        const md = resolve(skillDir, "SKILL.md");
        if (!existsSync(md)) continue;
        const { name, description } = parseSkillFrontmatter(readFileSync(md, "utf8"));
        const skillName = name || ent.name;
        result.push({
          name: skillName,
          description: description || "",
          path: skillDir,
          scope: root.scope,
          enabled: !disabled.has(skillName),
        });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 删除全局技能目录（仅允许两个根之内；会话项目级技能不在此管理） */
  async deleteGlobalSkill(path: string): Promise<void> {
    const target = resolve(path);
    const allowed = this.globalSkillRoots().some((root) => {
      const p = resolve(root.dir);
      return target === p || target.startsWith(p + sep);
    });
    if (!allowed) throw new Error("仅允许删除全局技能目录（server/.pi/skills 或 ~/.agents/skills）内 的技能");
    if (!existsSync(target)) throw new Error(`技能目录不存在: ${path}`);
    rmSync(target, { recursive: true, force: true });
  }

  async listProjectFiles(id: string, relativeDir: string): Promise<ProjectFileEntry[]> {
    const entry = this.requireEntry(id);
    const root = entry.controlState.allowedRoots[0] ?? entry.meta.cwd;
    const target = resolve(root, relativeDir || ".");
    // 仅允许项目根内浏览（@ 补全不越过项目边界）
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error("不允许浏览项目根目录之外的路径");
    }
    if (!existsSync(target)) return [];
    const HIDDEN = new Set(["node_modules", ".git", ".pi", "__pycache__", "dist"]);
    const entries = readdirSync(target, { withFileTypes: true })
      .filter((e) => !HIDDEN.has(e.name) && !e.name.startsWith("."))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 500)
      .map((e) => {
        const rel = join(relativeDir ? relativeDir.replace(/[\\/]+$/, "") : "", e.name).replace(/\\/g, "/");
        return {
          name: e.name,
          relativePath: e.isDirectory() ? `${rel}/` : rel,
          directory: e.isDirectory(),
        };
      });
    return entries;
  }

  /** 列出会话所属项目的地图图层（项目内 .latio/webgis 或会话目录下 webgis） */
  async listMapLayers(id: string): Promise<MapLayer[]> {
    const entry = this.requireEntry(id);
    return new MapLayerStore(this.webgisDirFor(entry.meta, entry.sessionDir)).list();
  }

  /** 读取图层 GeoJSON 原文（越界/缺失返回 null；路径由图层仓库按 id 映射） */
  async readMapLayerGeoJSON(id: string, layerId: string): Promise<string | null> {
    const entry = this.requireEntry(id);
    const found = new MapLayerStore(this.webgisDirFor(entry.meta, entry.sessionDir)).read(layerId);
    if (!found) return null;
    return readFileSync(found.absPath, "utf8");
  }

  /**
   * 会话的矢量上传上下文（拖拽上图）：webgis 目录、便携 Python、读取基准目录。
   * 路由层据此把 multipart 文件落盘到 webgis/uploads 并调 ingestVectorAsLayer 登记。
   */
  sessionUploadContext(id: string): {
    webgisDir: string;
    pythonExecutable: string;
    cwd: string;
    sessionId: string;
  } {
    const entry = this.requireEntry(id);
    return {
      webgisDir: this.webgisDirFor(entry.meta, entry.sessionDir),
      pythonExecutable: this.config.pythonExecutable,
      cwd: entry.meta.cwd,
      sessionId: entry.meta.id,
    };
  }

  async dispose(): Promise<void> {
    for (const entry of this.sessions.values()) {
      this.teardownSession(entry);
    }
    this.sessions.clear();
  }

  /** 停止运行态：审批/提问清零、关闭会话与事件流（不动 meta 与磁盘数据） */
  private teardownSession(entry: SessionEntry): void {
    entry.closing = true;
    this.resolvePending(entry.meta.id, false);
    this.resolvePendingQuestions(entry.meta.id);
    entry.session?.dispose();
    entry.session = null;
    entry.loader = null;
    entry.eventsStream?.end();
    entry.eventsStream = null;
  }

  private requireEntry(id: string): SessionEntry {
    const entry = this.sessions.get(id);
    if (!entry) throw new Error(`会话不存在: ${id}`);
    return entry;
  }

  /** meta 变更统一出口：更新时间戳、写盘、广播 session.updated */
  private touchMeta(entry: SessionEntry, broadcast = true): void {
    entry.meta.updatedAt = new Date().toISOString();
    this.writeMeta(entry);
    if (broadcast) {
      this.emit(
        entry,
        makeEvent(entry.meta.id, () => ({ type: "session.updated", session: this.toInfo(entry) }))
      );
    }
  }

  private writeMeta(entry: SessionEntry): void {
    if (this.sortOrderNeedsPersist) {
      for (const existing of this.sessions.values()) {
        writeFileSync(resolve(existing.sessionDir, "meta.json"), JSON.stringify(existing.meta, null, 2), "utf8");
      }
      this.sortOrderNeedsPersist = false;
    }
    writeFileSync(resolve(entry.sessionDir, "meta.json"), JSON.stringify(entry.meta, null, 2), "utf8");
  }

  /** 对外会话信息（剔除 piSessionFile 等内部字段） */
  private toInfo(entry: SessionEntry): AgentSessionInfo {
    const { piSessionFile: _omitted, ...rest } = entry.meta;
    return {
      ...rest,
      permissions: { ...entry.meta.permissions },
      status: entry.status,
      dir: entry.sessionDir,
    };
  }

  private openEventsStream(entry: SessionEntry): void {
    if (entry.eventsStream) return;
    const file = resolve(entry.sessionDir, "logs", "events.jsonl");
    entry.nextSeq = Math.max(entry.nextSeq, readLastSeq(file));
    entry.eventsStream = createWriteStream(file, { flags: "a" });
    entry.eventsStream.on("error", (err) => {
      console.warn(`[piAdapter] events.jsonl 写入失败（会话 ${entry.meta.id}）: ${err.message}`);
    });
  }

  /** 关闭事件流并等待写入落盘（编辑重发截断文件前必须调用，避免旧缓冲写回） */
  private async closeEventsStream(entry: SessionEntry): Promise<void> {
    const stream = entry.eventsStream;
    entry.eventsStream = null;
    if (!stream) return;
    await new Promise<void>((done) => stream.end(() => done()));
  }

  /** 审批桥：登记 pending 并广播 approval.required，超时/取消自动拒绝 */
  private handleApprovalRequest(sessionId: string, req: ApprovalRequest): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    return new Promise<boolean>((resolve) => {
      // 统一出口：放行/拒绝 + 广播 approval.resolved（落盘供回放恢复终态）
      const resolveWith = (approved: boolean) => {
        clearTimeout(timer);
        this.pendingApprovals.delete(req.requestId);
        if (!approved) entry?.blockedCalls.add(req.callId);
        if (entry) {
          this.emit(
            entry,
            makeEvent(sessionId, () => ({
              type: "approval.resolved",
              request_id: req.requestId,
              approved,
            }))
          );
        }
        resolve(approved);
      };
      const timer = setTimeout(() => resolveWith(false), this.config.approvalTimeoutMs);
      this.pendingApprovals.set(req.requestId, {
        sessionId,
        resolve: (approved) => resolveWith(approved),
      });
      if (entry) {
        this.emit(
          entry,
          makeEvent(sessionId, () => ({
            type: "approval.required",
            request_id: req.requestId,
            tool: req.tool,
            call_id: req.callId,
            input: req.input,
            summary: req.summary,
          }))
        );
      } else {
        clearTimeout(timer);
        resolve(false);
      }
    });
  }

  /** 将某会话的全部待审批置为指定结果（cancel/dispose 防挂起泄漏） */
  private resolvePending(sessionId: string, approved: boolean): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      if (pending.sessionId === sessionId) {
        pending.resolve(approved);
        this.pendingApprovals.delete(requestId);
      }
    }
  }

  /** 提问桥：登记 pending 并广播 question.required，超时/取消自动收敛（对齐审批桥） */
  private handleQuestionRequest(sessionId: string, questions: AskUserQuestion[]): Promise<AskUserResult> {
    const entry = this.sessions.get(sessionId);
    const requestId = randomUUID();
    return new Promise<AskUserResult>((resolve) => {
      // 统一出口：广播 question.answered（落盘供回放恢复终态）
      const resolveWith = (result: AskUserResult) => {
        clearTimeout(timer);
        this.pendingQuestions.delete(requestId);
        if (entry) {
          this.emit(
            entry,
            makeEvent(sessionId, () => ({
              type: "question.answered",
              request_id: requestId,
              ...(result.answers ? { answers: result.answers } : {}),
              ...(result.cancelled ? { cancelled: true } : {}),
              ...(result.timeout ? { timeout: true } : {}),
            }))
          );
        }
        resolve(result);
      };
      const timer = setTimeout(() => resolveWith({ timeout: true }), this.config.questionTimeoutMs);
      this.pendingQuestions.set(requestId, { sessionId, resolve: resolveWith });
      if (entry) {
        this.emit(
          entry,
          makeEvent(sessionId, () => ({ type: "question.required", request_id: requestId, questions }))
        );
      } else {
        clearTimeout(timer);
        this.pendingQuestions.delete(requestId);
        resolve({ cancelled: true });
      }
    });
  }

  /** 将某会话的全部待答提问置为取消（cancel/dispose 防挂起泄漏） */
  private resolvePendingQuestions(sessionId: string): void {
    for (const [requestId, pending] of this.pendingQuestions) {
      if (pending.sessionId === sessionId) {
        pending.resolve({ cancelled: true });
        this.pendingQuestions.delete(requestId);
      }
    }
  }

  private onSessionEvent(entry: SessionEntry, event: unknown): void {
    const msg = event as { type?: string } & Record<string, unknown>;
    if (msg.type === "agent_start") {
      entry.status = "running";
    }
    if (msg.type === "agent_end") {
      entry.status = "idle";
    }
    for (const e of this.translate(entry, msg)) {
      this.emit(entry, e);
    }
  }

  /** 分配 seq、落盘并广播；返回本次分配的 seq（sendMessage 用它回传消息定位） */
  private emit(entry: SessionEntry, event: AgentEvent): number {
    const seq = entry.nextSeq++;
    event.seq = seq;
    if (!NON_PERSISTED_EVENT_TYPES.has(event.type)) {
      const line = `${JSON.stringify({ seq, event })}\n`;
      if (entry.eventsStream?.writable) {
        entry.eventsStream.write(line);
      }
    }
    for (const cb of entry.subscribers) {
      try {
        cb(event);
      } catch {
        // 单个订阅者异常不影响其他订阅者与事件处理
      }
    }
    return seq;
  }

  /**
   * Pi 事件（与 SDK session.subscribe 事件同构）→ 内部 AgentEvent。
   * Pi 的具体字段名不允许泄漏到本函数之外。
   */
  private translate(entry: SessionEntry, msg: { type?: string } & Record<string, unknown>): AgentEvent[] {
    const sessionId = entry.meta.id;
    switch (msg.type) {
      case "turn_start":
        return [makeEvent(sessionId, () => ({ type: "turn.started" }))];

      case "message_update": {
        const e = msg.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
        if (e?.type === "text_delta" && typeof e.delta === "string") {
          return [makeEvent(sessionId, () => ({ type: "assistant.delta", delta: e.delta as string }))];
        }
        if (e?.type === "thinking_delta" && typeof e.delta === "string") {
          return [makeEvent(sessionId, () => ({ type: "assistant.thinking_delta", delta: e.delta as string }))];
        }
        return [];
      }

      case "message_end": {
        const m = msg.message as AssistantMessagePayload | undefined;
        if (m?.role !== "assistant") return [];
        if (m.stopReason === "error") {
          return [
            makeEvent(sessionId, () => ({
              type: "agent.error",
              error: withEffortHint(String(m.errorMessage ?? "LLM 调用失败")),
            })),
          ];
        }
        const events: AgentEvent[] = [];
        // token 账单与文本无关也要发（上下文占用条依赖每轮真实 usage）
        const u = m.usage;
        if (u && typeof u.input === "number" && u.input >= 0) {
          const inputTokens = u.input;
          const outputTokens = u.output ?? 0;
          events.push(
            makeEvent(sessionId, () => ({
              type: "turn.usage",
              usage: {
                input: inputTokens,
                output: outputTokens,
                ...(typeof u.cacheRead === "number" ? { cacheRead: u.cacheRead } : {}),
                ...(typeof u.cacheWrite === "number" ? { cacheWrite: u.cacheWrite } : {}),
                ...(typeof u.reasoning === "number" ? { reasoning: u.reasoning } : {}),
                totalTokens: u.totalTokens ?? inputTokens + outputTokens,
              },
            }))
          );
        }
        const thinking = (m.content ?? [])
          .filter((c) => c.type === "thinking")
          .map((c) => c.thinking ?? c.text ?? "")
          .join("");
        const text = (m.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("");
        // 完整思考块用于历史回放（live 流走 thinking_delta 聚合）
        if (thinking) {
          events.push(makeEvent(sessionId, () => ({ type: "assistant.thinking", text: thinking })));
        }
        if (text) {
          events.push(makeEvent(sessionId, () => ({ type: "assistant.message", text })));
        }
        return events;
      }

      case "tool_execution_start": {
        const { tool, callId } = readToolCall(msg);
        return [
          makeEvent(sessionId, () => ({ type: "tool.started", tool, call_id: callId })),
          makeEvent(sessionId, () => ({
            type: "tool.input",
            tool,
            call_id: callId,
            input: msg.args ?? {},
          })),
        ];
      }

      case "tool_execution_end": {
        const { tool, callId } = readToolCall(msg);
        const result = msg.result as
          | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
          | undefined;
        const output = (result?.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n")
          .slice(0, 8000);
        // 被审批/权限/模式门控阻止的调用与显式 isError 均视为失败
        const success = !entry.blockedCalls.has(callId) && result?.isError !== true;
        return [
          makeEvent(sessionId, () => ({ type: "tool.output", tool, call_id: callId, output })),
          makeEvent(sessionId, () => ({ type: "tool.completed", tool, call_id: callId, success })),
        ];
      }

      case "turn_end":
        return [makeEvent(sessionId, () => ({ type: "turn.completed" }))];

      case "compaction_start":
        return [
          makeEvent(sessionId, () => ({ type: "session.compacting", reason: String(msg.reason ?? "manual") })),
        ];

      case "compaction_end": {
        const result = msg.result as { tokensBefore?: number; estimatedTokensAfter?: number } | undefined;
        return [
          makeEvent(sessionId, () => ({
            type: "session.compacted",
            reason: String(msg.reason ?? "manual"),
            ...(typeof result?.tokensBefore === "number" ? { tokensBefore: result.tokensBefore } : {}),
            ...(typeof result?.estimatedTokensAfter === "number"
              ? { tokensAfter: result.estimatedTokensAfter }
              : {}),
            ...(msg.aborted === true ? { aborted: true } : {}),
            ...(msg.errorMessage ? { errorMessage: String(msg.errorMessage) } : {}),
          })),
        ];
      }

      case "agent_end":
        // 每次底层运行结束都发 session.completed；
        // 自动重试会开启新一轮 agent_start/agent_end，前端据此恢复状态即可
        return [makeEvent(sessionId, () => ({ type: "session.completed" }))];

      case "response":
        if (msg.success === false) {
          return [
            makeEvent(sessionId, () => ({
              type: "agent.error",
              error: String(JSON.stringify(msg.error) ?? "RPC 命令失败"),
            })),
          ];
        }
        return [];

      default:
        // toolcall_* / thinking_start|end / queue_update / compaction_* 等暂不映射
        return [];
    }
  }
}

/** 读 events.jsonl 最后一行的 seq（文件不存在或为空返回 0） */
function readLastSeq(file: string): number {
  try {
    if (!existsSync(file)) return 0;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      const rec = JSON.parse(trimmed) as { seq?: unknown };
      return typeof rec.seq === "number" ? rec.seq + 1 : 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

/** 递归统计目录的文件数与字节总数（会话迁移复制校验用） */
function treeStats(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = treeStats(full);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += statSync(full).size;
    }
  }
  return { files, bytes };
}

/** 在事件文件中定位 seq 对应的用户消息：返回其为第几条用户消息（1-based）与原图片 */
function findUserMessage(
  file: string,
  seq: number
): { userIndex: number; images?: UserMessageImage[] } | null {
  if (!existsSync(file)) return null;
  let seen = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as { seq?: number; event?: { type?: string; images?: UserMessageImage[] } };
      if (rec.event?.type !== "user.message") continue;
      seen += 1;
      if (rec.seq === seq) {
        return { userIndex: seen, ...(rec.event.images?.length ? { images: rec.event.images } : {}) };
      }
    } catch {
      // 跳过损坏行
    }
  }
  return null;
}

/**
 * 截断事件文件：保留 seq < keepBeforeSeq 的记录，被移除的尾部写入同目录
 * logs/events.replaced-<seq>-<ts>.jsonl 备份（编辑重发原地替换语义）。
 * 返回保留的记录数。
 */
export function truncateEventsBefore(file: string, keepBeforeSeq: number): number {
  if (!existsSync(file)) return 0;
  const kept: string[] = [];
  const removed: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as { seq?: number };
      if (typeof rec.seq === "number" && rec.seq < keepBeforeSeq) kept.push(trimmed);
      else removed.push(trimmed);
    } catch {
      // 损坏行一并移除
      removed.push(trimmed);
    }
  }
  if (removed.length) {
    const backup = resolve(dirname(file), `events.replaced-${keepBeforeSeq}-${Date.now()}.jsonl`);
    writeFileSync(backup, removed.map((l) => `${l}\n`).join(""), "utf8");
  }
  writeFileSync(file, kept.length ? kept.map((l) => `${l}\n`).join("") : "", "utf8");
  return kept.length;
}

/** 解析 SKILL.md 的 YAML frontmatter（仅取 name/description 两个标量字段） */
function parseSkillFrontmatter(md: string): { name?: string; description?: string } {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: { name?: string; description?: string } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(name|description):\s*(.*)$/);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^["']|["']$/g, "");
    if (value) result[kv[1] as "name" | "description"] = value;
  }
  return result;
}

interface AssistantMessagePayload {
  role?: string;
  content?: Array<{ type: string; text?: string; thinking?: string }>;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    totalTokens?: number;
  };
}

function readToolCall(msg: { type?: string } & Record<string, unknown>): { tool: string; callId: string } {
  const record = msg as Record<string, unknown>;
  const tool = String(record.toolName ?? record.tool ?? "unknown");
  const callId = String(record.toolCallId ?? record.callId ?? record.id ?? "");
  return { tool, callId };
}

/** 组装点使用的工厂：按配置选择 Agent 实现（settings 读取器供默认模型/压缩阈值） */
export function createPiAdapter(
  config: ServerConfig,
  readSettings: () => AppSettings,
  options?: { projectPaths?: () => string[] }
): AgentAdapter {
  return new PiAdapter(config, readSettings, options?.projectPaths);
}
