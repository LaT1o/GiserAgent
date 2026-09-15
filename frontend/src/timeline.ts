/**
 * 时间线事件归并与「计划已执行」判定（纯函数、无 React 依赖）。
 * live SSE 流与历史回放共用；独立成模块以便 tmp/verify-plan-revive.mts
 * 用真实事件序列做回放回归测试（「按此计划执行」按钮复活问题）。
 */
import type { AgentEvent } from "./types";
import type { TimelineItem } from "./components/TimelinePanel";

let itemSeq = 0;
export const nextKey = () => `t${++itemSeq}`;

/**
 * 事件 → 时间线条目的纯归并函数（live 流与历史回放共用）。
 * 返回处理后的新数组；busy 等会话级状态由调用方处理。
 */
export function reduceEvent(list: TimelineItem[], event: AgentEvent): TimelineItem[] {
  const last = list[list.length - 1];

  const closeStreamingThinking = (items: TimelineItem[]): TimelineItem[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i >= 0; i -= 1) {
      const it = copy[i];
      if (it.kind === "thinking" && it.streaming) copy[i] = { ...it, streaming: false };
      if (it.kind === "tool" || it.kind === "user") break;
    }
    return copy;
  };

  switch (event.type) {
    case "user.message": {
      // live 端发送时已本地渲染：末尾同文本且尚无 seq 的 user 项补上服务端 seq
      // （分支/编辑入口依赖 seq 定位历史消息；SSE 可能先于 HTTP 响应到达）
      if (last && last.kind === "user" && last.text === event.text && last.seq === undefined) {
        const seq = typeof event.seq === "number" ? event.seq : undefined;
        if (seq === undefined) return list;
        return [...list.slice(0, -1), { ...last, seq }];
      }
      if (last && last.kind === "user" && last.text === event.text) return list;
      return [
        ...list,
        {
          kind: "user",
          key: nextKey(),
          text: event.text ?? "",
          ...(event.images?.length ? { images: event.images } : {}),
          ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
        },
      ];
    }
    case "assistant.thinking_delta": {
      if (last && last.kind === "thinking" && last.streaming) {
        return [...list.slice(0, -1), { ...last, text: last.text + (event.delta ?? "") }];
      }
      return [...list, { kind: "thinking", key: nextKey(), text: event.delta ?? "", streaming: true }];
    }
    case "assistant.thinking": {
      // 完整思考（message_end 聚合）：live 流已由 delta 建好条目，仅关闭流式；
      // 历史回放没有 delta，在此新建完整条目
      if (last && last.kind === "thinking" && last.streaming) {
        return [...list.slice(0, -1), { ...last, streaming: false }];
      }
      // live 流中 thinking 条目已被 text_delta 关闭（末尾为流式 assistant）：
      // 完整事件仅供回放使用，此时丢弃，避免破坏末尾 assistant 的归并锚点
      if (last && last.kind === "assistant" && last.streaming) return list;
      return [...list, { kind: "thinking", key: nextKey(), text: event.text ?? "", streaming: false }];
    }
    case "assistant.delta": {
      const items = closeStreamingThinking(list);
      const lastAfter = items[items.length - 1];
      if (lastAfter && lastAfter.kind === "assistant" && lastAfter.streaming) {
        return [...items.slice(0, -1), { ...lastAfter, text: lastAfter.text + (event.delta ?? "") }];
      }
      return [...items, { kind: "assistant", key: nextKey(), text: event.delta ?? "", streaming: true }];
    }
    case "assistant.message": {
      const items = closeStreamingThinking(list);
      const lastAfter = items[items.length - 1];
      if (lastAfter && lastAfter.kind === "assistant" && lastAfter.streaming) {
        return [...items.slice(0, -1), { ...lastAfter, text: event.text ?? "", streaming: false }];
      }
      return [...items, { kind: "assistant", key: nextKey(), text: event.text ?? "", streaming: false }];
    }
    case "tool.started": {
      const items = closeStreamingThinking(list);
      return [
        ...items,
        {
          kind: "tool",
          key: nextKey(),
          callId: event.call_id ?? "",
          tool: event.tool ?? "unknown",
          status: "running",
          startedAt: Date.parse(event.timestamp),
          input: undefined,
          output: undefined,
          ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
        },
      ];
    }
    case "tool.input": {
      const idx = list.findIndex((it) => it.kind === "tool" && it.callId === event.call_id);
      if (idx < 0) return list;
      const updated = [...list];
      updated[idx] = { ...updated[idx], input: event.input } as TimelineItem;
      return updated;
    }
    case "tool.output": {
      const idx = list.findIndex((it) => it.kind === "tool" && it.callId === event.call_id);
      if (idx < 0) return list;
      const updated = [...list];
      updated[idx] = { ...updated[idx], output: event.output ?? "" } as TimelineItem;
      return updated;
    }
    case "tool.completed": {
      const idx = list.findIndex((it) => it.kind === "tool" && it.callId === event.call_id);
      if (idx < 0) return list;
      const it = list[idx];
      if (it.kind !== "tool") return list;
      const updated = [...list];
      updated[idx] = {
        ...it,
        status: event.success === false ? "failed" : "done",
        durationMs: Math.max(0, Date.parse(event.timestamp) - it.startedAt),
      };
      return updated;
    }
    case "approval.required": {
      return [
        ...list,
        {
          kind: "approval",
          key: nextKey(),
          requestId: event.request_id ?? "",
          tool: event.tool ?? "",
          summary: event.summary ?? "",
          status: "pending",
        },
      ];
    }
    case "approval.resolved": {
      // 审批结果（live 已本地置态，此处幂等恢复；回放时据此重建终态）
      const idx = list.findIndex(
        (it) => it.kind === "approval" && it.requestId === event.request_id
      );
      if (idx < 0) return list;
      const it = list[idx];
      if (it.kind !== "approval" || it.status !== "pending") return list;
      const updated = [...list];
      updated[idx] = {
        ...it,
        status: event.approved ? "approved" : "denied",
      };
      return updated;
    }
    case "question.required": {
      return [
        ...list,
        {
          kind: "question" as const,
          key: nextKey(),
          requestId: event.request_id ?? "",
          questions: event.questions ?? [],
          status: "pending" as const,
        },
      ];
    }
    case "question.answered": {
      // 作答结果（live 已本地置态，此处幂等恢复；回放时据此重建终态）
      const idx = list.findIndex(
        (it) => it.kind === "question" && it.requestId === event.request_id
      );
      if (idx < 0) return list;
      const it = list[idx];
      if (it.kind !== "question" || it.status !== "pending") return list;
      const updated = [...list];
      updated[idx] = {
        ...it,
        status: event.cancelled ? "cancelled" : event.timeout ? "timeout" : "answered",
        answers: event.answers,
      };
      return updated;
    }
    case "agent.error": {
      return [...list, { kind: "error", key: nextKey(), text: event.error ?? "未知错误" }];
    }
    case "session.compacting": {
      return [...list, { kind: "system", key: nextKey(), subtype: "compacting", text: "正在压缩上下文…" }];
    }
    case "session.compacted": {
      const detail =
        typeof event.tokensBefore === "number" && typeof event.tokensAfter === "number"
          ? `（约 ${event.tokensBefore.toLocaleString()} → ${event.tokensAfter.toLocaleString()} tokens）`
          : "";
      const text = event.aborted
        ? `上下文压缩已中止${event.errorMessage ? `：${event.errorMessage}` : ""}`
        : `已压缩上下文${detail}`;
      // 将最后一个"压缩中"系统行替换为完成态；没有则直接新增（回放场景）
      const idx = [...list].reverse().findIndex((it) => it.kind === "system" && it.subtype === "compacting");
      if (idx >= 0) {
        const realIdx = list.length - 1 - idx;
        const updated = [...list];
        updated[realIdx] = { kind: "system", key: updated[realIdx].key, subtype: "compacted", text };
        return updated;
      }
      return [...list, { kind: "system", key: nextKey(), subtype: "compacted", text }];
    }
    case "session.completed": {
      // 关闭所有流式条目，并追加轮次结束标记（该事件已落盘，回放可重建）。
      // 「执行过程」折叠以该标记为准：不能按“当前有无运行中条目”判定，
      // 工具/思考间隙会反复触发折叠与展开，造成画面抽搐。
      const closed = list.map((it) =>
        (it.kind === "assistant" || it.kind === "thinking") && it.streaming
          ? { ...it, streaming: false }
          : it
      );
      if (closed[closed.length - 1]?.kind === "turnEnd") return closed;
      return [...closed, { kind: "turnEnd", key: nextKey() }];
    }
    default:
      return list;
  }
}

/**
 * 已执行计划的 key 集合（「按此计划执行」按钮不再复活的判定）。
 * 主判定用 seq：计划之后存在用户消息（user.seq > submit_plan.seq）即已执行，
 * 天然免疫回放重建时的 key 变化与末尾项干扰；项缺 seq（历史遗留数据）时
 * 回退为倒序扫描语义（遇到用户消息后，更早的 submit_plan 即视为已执行）。
 */
export function computeExecutedPlans(items: TimelineItem[]): Set<string> {
  const keys = new Set<string>();
  /** 计划之后是否有用户消息：user.seq 大于计划 seq，或无 seq 的乐观项（live 发送瞬间，必然在末尾） */
  const hasLaterUser = (planSeq: number) =>
    items.some(
      (it) =>
        it.kind === "user" &&
        (it.seq === undefined || (typeof it.seq === "number" && it.seq > planSeq))
    );
  let seenUser = false;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "user") {
      seenUser = true;
    } else if (item.kind === "tool" && item.tool === "submit_plan") {
      if (typeof item.seq === "number") {
        if (hasLaterUser(item.seq)) keys.add(item.key);
      } else if (seenUser) {
        keys.add(item.key);
      }
    }
  }
  return keys;
}
