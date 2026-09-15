/**
 * 项目实体（workspace/projects.json，本地文件不入版本库）。
 *
 * 项目 = 名称 + 绝对路径的轻量注册表，用于：
 * - 新建会话时从下拉选择项目（代替手输路径）
 * - 侧栏按项目分组展示会话（会话侧只存 projectPath，删除项目不影响会话）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";

export interface Project {
  id: string;
  /** 展示名称（默认取路径末段） */
  name: string;
  /** 项目目录绝对路径（创建时校验存在） */
  path: string;
  createdAt: string;
  /** 最近一次有会话绑定的时间（分组排序用） */
  lastUsedAt: string;
  /** 手动排序序号（拖动排序持久化，list 按数组序返回即等于该序） */
  sortOrder?: number;
}

interface ProjectsFile {
  projects: Project[];
}

/** 归一化磁盘内容（损坏/缺字段跳过） */
function sanitize(raw: unknown): Project[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as ProjectsFile).projects;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (p): p is Project =>
      p &&
      typeof p.id === "string" &&
      typeof p.name === "string" &&
      typeof p.path === "string" &&
      typeof p.createdAt === "string"
  );
}

export class ProjectStore {
  private projects: Project[];
  private readonly file: string;

  constructor(workspaceDir: string) {
    this.file = resolve(workspaceDir, "projects.json");
    let loaded: unknown = null;
    try {
      if (existsSync(this.file)) loaded = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (err) {
      console.warn(`[projects] projects.json 解析失败，从空列表开始: ${(err as Error).message}`);
    }
    this.projects = sanitize(loaded);
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ projects: this.projects }, null, 2), "utf8");
  }

  list(): Project[] {
    return this.projects.map((p) => ({ ...p }));
  }

  get(id: string): Project | undefined {
    const found = this.projects.find((p) => p.id === id);
    return found ? { ...found } : undefined;
  }

  create(name: string, path: string): Project {
    const abs = resolve(path);
    if (!isAbsolute(abs) || !existsSync(abs)) {
      throw new Error(`项目路径不存在或不是绝对路径: ${path}`);
    }
    if (this.projects.some((p) => p.path === abs)) {
      throw new Error(`该路径已注册为项目: ${abs}`);
    }
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name: name.trim() || abs.split(/[\\/]/).filter(Boolean).pop() || abs,
      path: abs,
      createdAt: now,
      lastUsedAt: now,
      // 新项目固定追加到列表末尾（顺序只随用户拖动变化，杜绝 lastUsedAt 引起的跳动）
      sortOrder: this.projects.reduce((max, p) => Math.max(max, p.sortOrder ?? -1), -1) + 1,
    };
    this.projects.push(project);
    this.persist();
    return { ...project };
  }

  /** 手动排序：按入参数组位次重排（未列出的项目保持相对序附在末尾） */
  reorder(orderedIds: string[]): void {
    const byId = new Map(this.projects.map((p) => [p.id, p]));
    const next: Project[] = [];
    for (const id of orderedIds) {
      const found = byId.get(id);
      if (found) {
        next.push(found);
        byId.delete(id);
      }
    }
    for (const rest of byId.values()) next.push(rest);
    next.forEach((p, i) => (p.sortOrder = i));
    this.projects = next;
    this.persist();
  }

  rename(id: string, name: string): Project {
    const found = this.projects.find((p) => p.id === id);
    if (!found) throw new Error(`项目不存在: ${id}`);
    if (!name.trim()) throw new Error("项目名称不能为空");
    found.name = name.trim();
    this.persist();
    return { ...found };
  }

  delete(id: string): void {
    if (!this.projects.some((p) => p.id === id)) throw new Error(`项目不存在: ${id}`);
    this.projects = this.projects.filter((p) => p.id !== id);
    this.persist();
  }

  /** 会话绑定项目时更新最近使用时间（不存在时静默忽略，容错路径直传场景） */
  touchByPath(path: string): void {
    const found = this.projects.find((p) => p.path === resolve(path));
    if (!found) return;
    found.lastUsedAt = new Date().toISOString();
    this.persist();
  }
}
