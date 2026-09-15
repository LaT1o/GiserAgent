/**
 * todo 任务清单工具（改编自 Pi 官方示例 todo.ts，去 TUI 化）。
 *
 * 仅保留工具本体（registerTool）；渲染组件与 /todos 命令依赖 TUI，已删除。
 * 每个会话一个独立扩展实例，内存态天然按会话隔离，无需从 session 重建。
 * Agent 的调用会以普通工具事件出现在前端时间线中。
 */

import { Type } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

const TodoParams = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("toggle"), Type.Literal("clear")], {
    description: "操作：list 查看全部 / add 新增 / toggle 切换完成状态 / clear 清空",
  }),
  text: Type.Optional(Type.String({ description: "add 时的任务文本" })),
  id: Type.Optional(Type.Number({ description: "toggle 时的任务 id" })),
});

export function createTodoExtension(): InlineExtension {
  return {
    name: "todo",
    hidden: true,
    factory: (pi) => {
      let todos: Todo[] = [];
      let nextId = 1;

      pi.registerTool({
        name: "todo",
        label: "Todo",
        description:
          "管理任务清单。多步骤任务请先用 add 拆解步骤，完成一步后用 toggle 勾选，随时 list 查看。" +
          "行动：list / add(text) / toggle(id) / clear。",
        promptSnippet: "manage a todo list for multi-step tasks",
        parameters: TodoParams,
        async execute(_toolCallId, params) {
          switch (params.action) {
            case "list":
              return {
                content: [
                  {
                    type: "text",
                    text: todos.length
                      ? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
                      : "No todos",
                  },
                ],
                details: { todos: [...todos] },
              };
            case "add": {
              if (!params.text) {
                return { content: [{ type: "text", text: "Error: text required for add" }], details: { todos: [...todos] } };
              }
              const item: Todo = { id: nextId++, text: params.text, done: false };
              todos.push(item);
              return { content: [{ type: "text", text: `Added todo #${item.id}: ${item.text}` }], details: { todos: [...todos] } };
            }
            case "toggle": {
              const todo = todos.find((t) => t.id === params.id);
              if (!todo) {
                return { content: [{ type: "text", text: `Todo #${params.id} not found` }], details: { todos: [...todos] } };
              }
              todo.done = !todo.done;
              return { content: [{ type: "text", text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}` }], details: { todos: [...todos] } };
            }
            case "clear": {
              const count = todos.length;
              todos = [];
              nextId = 1;
              return { content: [{ type: "text", text: `Cleared ${count} todos` }], details: { todos: [] } };
            }
          }
        },
      });
    },
  };
}
