/**
 * 设置页「回收站」面板：软删除会话的恢复与彻底删除。
 *
 * 说明（与当前服务端实现一致）：回收站不是独立的备份目录，
 * 软删除只在会话自己的 meta.json 写入 deletedAt 并停止运行，
 * 文件仍留在原会话目录（项目内会话在 <项目>/.latio/sessions/<id>，
 * 临时会话在中央 workspace/sessions/<id>）；恢复即清除该标记，
 * 彻底删除才会递归删除整个会话目录，不可恢复。
 */

import type { SessionInfo } from "../types";

interface Props {
  trashSessions: SessionInfo[];
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
  /** 清空回收站（彻底删除全部，不可恢复） */
  onClearTrash: () => void;
  onRefresh: () => void;
}

const displayName = (session: SessionInfo) => session.title?.trim() || "新建会话";
const deletedAt = (session: SessionInfo) =>
  session.deletedAt ? new Date(session.deletedAt).toLocaleString() : "";

export default function TrashPanel({ trashSessions, onRestore, onPurge, onClearTrash, onRefresh }: Props) {
  return (
    <div className="trash-panel">
      <div className="trash-panel-head">
        <div>
          <div className="trash-panel-title">回收站（{trashSessions.length}）</div>
          <div className="dialog-hint">
            移入回收站只做软删除标记，会话数据仍保留在原目录；恢复即取消标记，彻底删除才会删除会话目录且不可恢复。
          </div>
        </div>
        <div className="trash-panel-actions">
          <button type="button" className="dialog-btn-secondary" onClick={onRefresh}>
            刷新
          </button>
          <button
            type="button"
            className="dialog-btn-secondary danger"
            disabled={!trashSessions.length}
            title="彻底删除回收站内全部会话（不可恢复）"
            onClick={onClearTrash}
          >
            清空回收站
          </button>
        </div>
      </div>

      {trashSessions.length === 0 ? (
        <p className="session-empty">回收站为空</p>
      ) : (
        <ul className="trash-list">
          {trashSessions.map((session) => (
            <li key={session.id} className="trash-item">
              <span className="trash-name" title={displayName(session)}>
                {displayName(session)}
              </span>
              <span className="trash-meta" title={session.projectPath ?? "临时目录"}>
                {session.projectPath ? `${session.projectPath} · ` : "临时目录 · "}
                {deletedAt(session)}
              </span>
              {/* 行内按钮而非 RowMenu 浮层：弹窗层级 320 高于浮层 200，菜单会被弹窗盖住 */}
              <button
                type="button"
                className="trash-action"
                onClick={() => onRestore(session.id)}
              >
                恢复
              </button>
              <button
                type="button"
                className="trash-action danger"
                title="彻底删除该会话目录（不可恢复）"
                onClick={() => onPurge(session.id)}
              >
                彻底删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
