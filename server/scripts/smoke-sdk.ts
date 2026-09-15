/**
 * SDK 链路冒烟脚本（不依赖 Fastify、不 spawn 子进程）：
 * 进程内 createAgentSession → 订阅事件 → 发送 prompt → 打印全部事件 → 结束退出。
 *
 * 一次验证：ModelRuntime（models.json 自定义 provider）、
 * createAgentSession（inMemory 会话）、customTools（opengis 工具）、
 * 内联扩展（tool_call 拦截日志）、事件流与 RPC JSONL 同构性。
 *
 * 运行：npm run smoke:sdk
 */

import "dotenv/config";
import { resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, SERVER_DIR } from "../src/config.js";
import { readModelsFile } from "../src/providers.js";
import { createOpenGisTool } from "../src/agent/pi/extensions/python-runner.js";

const config = loadConfig();

const prompt =
  process.argv[2] || "请调用 opengis 工具执行 print(6*7)，然后告诉我结果。";

const modelRuntime = await ModelRuntime.create({
  authPath: resolve(SERVER_DIR, ".pi", "auth.json"),
  modelsPath: resolve(SERVER_DIR, ".pi", "models.json"),
});
// 模型来源：命令行 [providerId] [modelId] → models.json 首个提供商的第一个模型
const modelsData = readModelsFile(resolve(SERVER_DIR, ".pi", "models.json"));
const [argProvider, argModel] = process.argv.slice(3);
const firstProviderId = Object.entries(modelsData.providers).find(([, p]) => p.models?.length)?.[0];
const providerId = argProvider || firstProviderId;
const modelId = argModel || (providerId ? modelsData.providers[providerId]?.models?.[0]?.id : undefined);
if (!providerId || !modelId) {
  console.error("[smoke] models.json 中没有可用模型，请先在界面“设置 → 模型提供商”中添加提供商并导入模型");
  process.exit(1);
}
const model = modelRuntime.getModel(providerId, modelId);
if (!model) {
  console.error(`[smoke] models.json 中未找到 ${providerId}/${modelId}`);
  process.exit(1);
}
console.log(`[smoke] provider=${providerId} model=${modelId}`);

const cwd = resolve(SERVER_DIR, "..", "workspace");
const loader = new DefaultResourceLoader({
  cwd,
  agentDir: resolve(SERVER_DIR, ".pi"),
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  extensionFactories: [
    {
      name: "smoke-tool-logger",
      factory: (pi) => {
        pi.on("tool_call", async (event) => {
          console.log(`[smoke][tool_call 拦截] ${event.toolName} callId=${event.toolCallId}`);
          return undefined;
        });
      },
    },
  ],
});
await loader.reload();

const { session } = await createAgentSession({
  cwd,
  model,
  modelRuntime,
  tools: config.agentTools,
  customTools: [createOpenGisTool(config.pythonExecutable, cwd)],
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager: SettingsManager.inMemory(),
});
await session.bindExtensions({ mode: "print" });
console.log("[smoke] 会话已创建（SDK 进程内）\n");

let settled = false;
const unsubscribe = session.subscribe((event) => {
  console.log(JSON.stringify(event));
  if (event.type === "agent_settled") settled = true;
});

const timeout = setTimeout(() => {
  console.error("[smoke] 超时退出");
  finish(1);
}, 120_000);

function finish(code: number): void {
  clearTimeout(timeout);
  unsubscribe();
  session.dispose();
  process.exit(code);
}

try {
  await session.prompt(prompt);
  console.log(`\n[smoke] prompt 完成 settled=${settled}`);
  finish(0);
} catch (err) {
  console.error(`[smoke] prompt 失败: ${(err as Error).message}`);
  finish(1);
}
