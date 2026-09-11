/**
 * pi-live-tool-output — 命令（工具）输出：执行中实时展开 / 完成后自动折叠
 *
 * 效果（与 live-thinking 同构，作用于工具输出而非思考块）：
 * - 工具（bash/read/grep 等）正在执行时：强制展开，实时看到完整输出。
 * - 工具执行结束后：自动折叠为预览（bash 5 行 / 其他前若干行 + "N more lines" 提示）。
 * - 折叠后仍可点击该输出块，或按 ctrl+o 切换展开状态。
 *
 * 原理：
 * - pi 内置的折叠由全局 toolOutputExpanded 控制（ctrl+o 切换，对所有工具输出一刀切），
 *   无法区分「正在执行」和「已结束」。
 * - ToolExecutionComponent.updateResult(result, isPartial) 的第二个参数正好表示
 *   「流式中间结果」还是「最终结果」，因此在补丁里直接把 expanded 设为 isPartial 即可。
 * - 执行结束的调用来自 tool_execution_end → updateResult(result)（isPartial 缺省 false）。
 *
 * 配置：~/.pi/agent/live-tool-output.json
 *   { "enabled": true }
 *
 * 命令：/live-tool-output [on|off]  切换启用状态
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ToolExecutionComponent,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

interface LiveToolOutputConfig {
  enabled: boolean;
}

function resolveAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return join(homedir(), configured.slice(2));
  }
  return configured;
}

const CONFIG_FILE = join(resolveAgentDir(), "live-tool-output.json");

function loadConfig(): LiveToolOutputConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<LiveToolOutputConfig>;
      return { enabled: raw.enabled !== false };
    }
  } catch {
    // 配置损坏时回退到默认值
  }
  return { enabled: true };
}

function saveConfig(config: LiveToolOutputConfig): void {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
  } catch {
    // 写入失败不致命
  }
}

/** ToolExecutionComponent 内部使用的私有字段（duck-typing） */
interface ToolExecutionInternal {
  expanded: boolean;
  updateResult(result: unknown, isPartial?: boolean): void;
}

type ToolExecutionPrototype = Record<string, any> & ToolExecutionInternal;

/** 记录在 prototype 上的原始 updateResult，用于 /reload 时卸载补丁 */
const ORIGINAL_KEY = "__liveToolOutputOriginalUpdateResult";

/** 安装 prototype 补丁：执行中展开、结束后折叠。幂等。 */
function installPatch(isEnabled: () => boolean): void {
  const proto = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype;
  if (typeof proto.updateResult !== "function") return;
  if (typeof proto[ORIGINAL_KEY] === "function") return; // 已安装

  const original = proto.updateResult;

  proto[ORIGINAL_KEY] = original;
  proto.updateResult = function (
    this: ToolExecutionInternal,
    result: unknown,
    isPartial?: boolean,
  ): void {
    if (isEnabled()) {
      // isPartial === true 只在 tool_execution_update（流式中间结果）时出现；
      // tool_execution_end 传缺省值 false，因此结束时自动折叠。
      this.expanded = isPartial === true;
    }
    return original.call(this, result, isPartial);
  };
}

/** 卸载补丁，恢复原始 updateResult */
function uninstallPatch(): void {
  const proto = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype;
  const original = proto[ORIGINAL_KEY];
  if (typeof original === "function") {
    proto.updateResult = original;
  }
  delete proto[ORIGINAL_KEY];
}

export default function liveToolOutput(pi: ExtensionAPI): void {
  const config = loadConfig();
  const isEnabled = () => config.enabled;

  const ensure = (): void => installPatch(isEnabled);

  ensure();

  pi.on("session_start", async () => {
    ensure();
  });

  pi.on("before_agent_start", async () => {
    ensure();
  });

  pi.on("message_start", async () => {
    ensure();
  });

  pi.on("session_shutdown", async (event) => {
    // reload/new/resume/fork 会重建扩展运行时，先卸载，由新实例重新安装，
    // 避免引用旧的配置闭包。
    if (event.reason !== "quit") {
      uninstallPatch();
    }
  });

  pi.registerCommand("live-tool-output", {
    description: "Toggle live tool output display (on|off)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on") config.enabled = true;
      else if (arg === "off") config.enabled = false;
      else config.enabled = !config.enabled;
      saveConfig(config);
      ctx.ui.notify(
        `实时命令输出: ${config.enabled ? "已开启（执行中展开，结束后折叠）" : "已关闭（跟随 toolOutputExpanded / ctrl+o 设置）"}`,
        "info",
      );
    },
  });
}
