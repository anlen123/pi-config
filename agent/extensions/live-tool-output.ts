/**
 * pi-live-tool-output — 命令（工具）输出：全程折叠，只留摘要行，点击/ctrl+o 才展开
 *
 * 效果（与 live-thinking 同构：历史里只留“输入 + 最终输出”）：
 * - 默认（liveExpand=false）：执行中**不展开**，执行完也**不展开**；整行被折叠成
 *   `collapsedLines` 行（默认 1 行，即工具调用那一行）+ 一行提示
 *   `… (N more lines • Ctrl+O to expand)`。
 * - liveExpand=true：恢复旧行为 —— 执行中实时展开，执行结束后自动折叠。
 * - 折叠后点击该输出块，或按 ctrl+o，仍可展开全部内容。
 * - 工具报错（isError）时不折叠，避免把报错信息折掉。
 * - 结果里带图片（截图等）时不折叠。
 *
 * 原理：
 * - pi 内置的折叠由全局 toolOutputExpanded（ctrl+o）控制，对所有工具输出一刀切，
 *   无法区分「正在执行」和「已结束」，折叠后也总是保留 10 行（bash）/24 行（diff）预览。
 * - 本插件对 `ToolExecutionComponent.prototype` 打两个补丁：
 *   1) `updateResult(result, isPartial)`：`isPartial===true` 只在执行中出现，
 *      用它决定 `expanded`；liveExpand=false 时一律折叠。
 *   2) `render(width)`：`expanded===false` 时把整行渲染结果裁到 collapsedLines 行，
 *      并追加一行提示。因为是在最终渲染结果上裁剪，所以对 pi-tool-display 之类
 *      自带 renderer 的工具（bash/read/edit/write…）同样生效，无需改它们。
 *
 * 配置：~/.pi/agent/live-tool-output.json
 *   {
 *     "enabled": true,                 // 总开关
 *     "liveExpand": false,             // 执行中是否实时展开（旧行为）
 *     "collapsedLines": 1,             // 折叠后保留的渲染行数（1 = 只留调用行）
 *     "hint": "… ({n} more lines • Ctrl+O to expand)"   // {n} 会被替换成剩余行数
 *   }
 *
 * 命令：
 *   /live-tool-output            切换总开关（等价 on|off）
 *   /live-tool-output on|off     开/关
 *   /live-tool-output live on|off   执行中实时展开 开/关
 *   /live-tool-output lines <n>  折叠后保留行数
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
  liveExpand: boolean;
  collapsedLines: number;
  hint: string;
}

const DEFAULT_CONFIG: LiveToolOutputConfig = {
  enabled: true,
  liveExpand: false,
  collapsedLines: 1,
  hint: "… ({n} more lines • Ctrl+O to expand)",
};

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

function clampLines(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CONFIG.collapsedLines;
  return Math.max(1, Math.min(50, Math.floor(value)));
}

function loadConfig(): LiveToolOutputConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<LiveToolOutputConfig>;
      return {
        enabled: raw.enabled !== false,
        liveExpand: raw.liveExpand === true,
        collapsedLines: clampLines(raw.collapsedLines ?? DEFAULT_CONFIG.collapsedLines),
        hint: typeof raw.hint === "string" && raw.hint.trim() ? raw.hint : DEFAULT_CONFIG.hint,
      };
    }
  } catch {
    // 配置损坏时回退到默认值
  }
  return { ...DEFAULT_CONFIG };
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
  result?: { isError?: boolean; content?: Array<{ type?: string }> };
  updateResult(result: unknown, isPartial?: boolean): void;
  render(width: number): string[];
}

type ToolExecutionPrototype = Record<string, any> & ToolExecutionInternal;

/** 记录在 prototype 上的原始方法，用于 /reload 时卸载补丁 */
const ORIGINAL_UPDATE_RESULT = "__liveToolOutputOriginalUpdateResult";
const ORIGINAL_RENDER = "__liveToolOutputOriginalRender";

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** 渲染结果里若已带 pi / pi-tool-display 的 “(N more lines)” 提示，优先用它的真实条数 */
function hiddenCount(lines: string[]): number | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = stripAnsi(lines[i] ?? "").match(/\((\d+)\s+more lines/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

/** 主题（用于给提示行上 muted 色），由事件上下文懒加载；拿不到就纯文本 */
let themeRef: { fg?: (color: string, text: string) => string } | undefined;

function paintHint(text: string): string {
  try {
    const fg = themeRef?.fg;
    if (typeof fg === "function") return fg.call(themeRef, "muted", text);
  } catch {
    // 主题未初始化 / 颜色不存在时退化为纯文本
  }
  return text;
}

/** 安装 prototype 补丁：默认全程折叠 + 折叠时裁到 N 行。幂等。 */
function installPatch(isConfig: () => LiveToolOutputConfig): void {
  const proto = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype;

  // --- 补丁 1：不再“执行中展开”，除非 liveExpand=true ---
  if (typeof proto.updateResult === "function" && typeof proto[ORIGINAL_UPDATE_RESULT] !== "function") {
    const original = proto.updateResult;
    proto[ORIGINAL_UPDATE_RESULT] = original;
    proto.updateResult = function (
      this: ToolExecutionInternal,
      result: unknown,
      isPartial?: boolean,
    ): void {
      const config = isConfig();
      if (config.enabled) {
        // isPartial === true 只在 tool_execution_update（流式中间结果）时出现；
        // liveExpand 关掉后：执行中也折叠，结束时保持折叠。
        this.expanded = config.liveExpand && isPartial === true;
      }
      return original.call(this, result, isPartial);
    };
  }

  // --- 补丁 2：折叠状态下把整行渲染结果裁到 collapsedLines 行 ---
  if (typeof proto.render === "function" && typeof proto[ORIGINAL_RENDER] !== "function") {
    const originalRender = proto.render;
    proto[ORIGINAL_RENDER] = originalRender;
    proto.render = function (this: ToolExecutionInternal, width: number): string[] {
      const lines = originalRender.call(this, width);
      const config = isConfig();
      if (!config.enabled) return lines;
      if (!Array.isArray(lines) || lines.length === 0) return lines;
      if (this.expanded) return lines;
      // 还没有执行结果（只显示了调用行 / Running…）时不动
      if (!this.result) return lines;
      // 报错完整展示，别把报错折掉
      if (this.result.isError) return lines;
      // 带图片的结果（截图/渲染图）不折叠，图片折成一行就没意义了
      const resultContent = this.result.content;
      if (Array.isArray(resultContent) && resultContent.some((item) => item?.type === "image")) {
        return lines;
      }

      // 行首会是空行/只有底色的“空”行（组件构造时的 Spacer + Box padding），
      // 折叠行数只算有可见文字的行。
      const start = lines.findIndex((line) => stripAnsi(line).trim().length > 0);
      if (start === -1) return lines;
      const content = lines.slice(start);

      const keep = clampLines(config.collapsedLines);
      if (content.length <= keep + 1) return lines; // 本来就很短，不用折叠

      const remaining = hiddenCount(lines) ?? content.length - keep;
      const out = [...lines.slice(0, start), ...content.slice(0, keep)];
      out.push(paintHint(config.hint.replace("{n}", String(remaining))));
      return out;
    };
  }
}

/** 卸载补丁，恢复原始方法（/reload、/new、/resume 时调用） */
function uninstallPatch(): void {
  const proto = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype;
  for (const [key, name] of [
    [ORIGINAL_UPDATE_RESULT, "updateResult"],
    [ORIGINAL_RENDER, "render"],
  ] as const) {
    const original = proto[key];
    if (typeof original === "function") {
      proto[name] = original;
    }
    delete proto[key];
  }
}

export default function liveToolOutput(pi: ExtensionAPI): void {
  const config = loadConfig();
  const getConfig = () => config;

  const ensure = (): void => installPatch(getConfig);

  // 启动即安装；session_start / before_agent_start / message_start 兜底
  ensure();

  const captureTheme = (ctx: any): void => {
    try {
      const t = ctx?.ui?.theme;
      if (t && typeof t.fg === "function") themeRef = t;
    } catch {
      // RPC 模式或主题未就绪：忽略
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    ensure();
    captureTheme(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    ensure();
    captureTheme(ctx);
  });

  pi.on("message_start", async (_event, ctx) => {
    ensure();
    captureTheme(ctx);
  });

  pi.on("session_shutdown", async (event) => {
    // reload/new/resume/fork 会重建扩展运行时，先卸载，由新实例重新安装，
    // 避免引用旧的配置闭包。
    if (event.reason !== "quit") {
      uninstallPatch();
    }
  });

  pi.registerCommand("live-tool-output", {
    description: "Tool output folding: /live-tool-output [on|off|live on|off|lines N]",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
      const [a, b] = parts;

      if (a === "live") {
        config.liveExpand = b === "on" ? true : b === "off" ? false : !config.liveExpand;
      } else if (a === "lines") {
        const n = Number(b);
        if (Number.isFinite(n)) config.collapsedLines = clampLines(n);
      } else if (a === "on") {
        config.enabled = true;
      } else if (a === "off") {
        config.enabled = false;
      } else {
        config.enabled = !config.enabled;
      }

      saveConfig(config);
      ctx.ui.notify(
        `命令输出: ${config.enabled ? "已开启" : "已关闭"}` +
          ` | 折叠保留 ${config.collapsedLines} 行` +
          ` | 执行中${config.liveExpand ? "实时展开" : "保持折叠"}`,
        "info",
      );
    },
  });
}
