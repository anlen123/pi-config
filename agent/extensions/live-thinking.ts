/**
 * pi-live-thinking — 实时思考展示 / 历史思考折叠
 *
 * 效果：
 * - 当前正在流式输出的消息：思考过程实时展开显示（即使全局 hideThinkingBlock: true）。
 * - 已完成的消息 / 历史记录：思考过程折叠为一行 "Thinking..." 标签。
 * - 点击折叠的思考标签可展开，再点击可收起（pi 内置鼠标支持）；Ctrl+T 可全局切换。
 *
 * 原理：
 * - pi 在 hideThinkingBlock: true 时会把所有思考块（包括正在流式输出的）折叠。
 * - 本插件对 AssistantMessageComponent.prototype.updateContent 做包装：
 *   仅当组件处于 streaming 状态时，临时把 hideThinkingBlock 视为 false，
 *   消息结束（message_end 调 updateContent(msg, false)）后自动恢复折叠。
 * - 历史消息的折叠与点击展开/收起均使用 pi 内置行为，不受影响。
 *
 * 配置：~/.pi/agent/live-thinking.json
 *   { "enabled": true, "label": "Thinking... (click to toggle)" }
 *   - enabled: 是否启用流式实时思考展示（默认 true）
 *   - label:   折叠时显示的标签文案（可选，默认用 pi 自带 "Thinking..."）
 *
 * 命令：/live-thinking [on|off]  切换启用状态
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AssistantMessageComponent,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

interface LiveThinkingConfig {
  enabled: boolean;
  label?: string;
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

const CONFIG_FILE = join(resolveAgentDir(), "live-thinking.json");

function loadConfig(): LiveThinkingConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<LiveThinkingConfig>;
      return {
        enabled: raw.enabled !== false,
        label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : undefined,
      };
    }
  } catch {
    // 配置损坏时回退到默认值
  }
  return { enabled: true };
}

function saveConfig(config: LiveThinkingConfig): void {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
  } catch {
    // 写入失败不致命
  }
}

/** AssistantMessageComponent 内部使用的私有字段（ duck-typing ） */
interface AssistantMessageInternal {
  hideThinkingBlock: boolean;
  isStreaming: boolean;
  updateContent(message: unknown, isStreaming?: boolean): void;
}

type AssistantMessagePrototype = Record<string, any> & AssistantMessageInternal;

/** 记录在 prototype 上的原始 updateContent，用于 /reload 时卸载补丁 */
const ORIGINAL_KEY = "__liveThinkingOriginalUpdateContent";

/**
 * 安装 prototype 补丁：streaming 状态下强制显示思考块。
 * 已安装时直接返回（幂等），重复安装由 session_shutdown 卸载保证不叠包。
 */
function installPatch(isEnabled: () => boolean): void {
  const proto = AssistantMessageComponent.prototype as unknown as AssistantMessagePrototype;
  if (typeof proto.updateContent !== "function") return;
  if (typeof proto[ORIGINAL_KEY] === "function") return; // 已安装

  const original = proto.updateContent;

  proto[ORIGINAL_KEY] = original;
  proto.updateContent = function (
    this: AssistantMessageInternal & Record<string, any>,
    message: unknown,
    isStreaming?: boolean,
  ): void {
    // 保持原签名默认值语义：updateContent(msg) 继承组件当前 isStreaming
    const streaming = isStreaming === undefined ? this.isStreaming : isStreaming;
    const previous = this.hideThinkingBlock;
    if (streaming && isEnabled()) {
      // 正在流式输出：即使全局设置为折叠，也临时展开思考
      this.hideThinkingBlock = false;
    }
    try {
      return original.call(this, message, isStreaming);
    } finally {
      this.hideThinkingBlock = previous;
    }
  };
}

/** 卸载补丁，恢复原始 updateContent（/reload、/new、/resume 时调用） */
function uninstallPatch(): void {
  const proto = AssistantMessageComponent.prototype as unknown as AssistantMessagePrototype;
  const original = proto[ORIGINAL_KEY];
  if (typeof original === "function") {
    proto.updateContent = original;
  }
  delete proto[ORIGINAL_KEY];
}

export default function liveThinking(pi: ExtensionAPI): void {
  const config = loadConfig();
  const isEnabled = () => config.enabled;

  const ensure = (): void => installPatch(isEnabled);

  // 启动即安装；session_start / before_agent_start / message_start 兜底
  // （覆盖 /reload、/new、/resume 之后扩展模块重新加载的场景）
  ensure();

  pi.on("session_start", async (_event, ctx) => {
    ensure();
    if (config.label) {
      ctx.ui.setHiddenThinkingLabel(config.label);
    }
  });

  pi.on("before_agent_start", async () => {
    ensure();
  });

  pi.on("message_start", async () => {
    ensure();
  });

  pi.on("session_shutdown", async (event) => {
    // 任何会重建扩展运行时的关停（reload/new/resume/fork）都先卸载，
    // 由重新加载的新模块实例再次安装，避免引用旧的配置闭包。
    if (event.reason !== "quit") {
      uninstallPatch();
    }
  });

  pi.registerCommand("live-thinking", {
    description: "Toggle live thinking display while streaming (on|off)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on") config.enabled = true;
      else if (arg === "off") config.enabled = false;
      else config.enabled = !config.enabled;
      saveConfig(config);
      ctx.ui.notify(
        `实时思考展示: ${config.enabled ? "已开启（流式时展开思考，结束后折叠）" : "已关闭（跟随 hideThinkingBlock 设置）"}`,
        "info",
      );
    },
  });
}
