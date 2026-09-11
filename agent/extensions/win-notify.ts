/**
 * win-notify — pi 的 Windows 右下角通知（适用于 pi 跑在 WSL 的环境）。
 *
 * 两类通知：
 *   1. 回复完成（agent_settled）—— 正常结束 / 中断 / 出错
 *   2. 等你操作（ui_prompt_start、tool_call）—— 需要你选择、确认、输入时提醒
 *
 * 命令：
 *   /win-notify          查看状态并弹一条测试通知
 *   /win-notify on|off   开启/关闭
 *   /win-notify test     只弹测试通知
 *
 * 环境变量：
 *   PI_WIN_NOTIFY=off            完全关闭
 *   PI_WIN_NOTIFY_DEBUG=1        在 stderr 打印调试信息
 *   PI_WIN_NOTIFY_PROMPT_TOOLS   追加"交互类工具名"正则片段，逗号分隔
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------- PowerShell

const PS_CANDIDATES = [
  "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  "/mnt/c/Program Files/PowerShell/7/pwsh.exe",
];

/** Toast 来源标识；注册自定义 AUMID 后可显示为 "Pi"。 */
const POWERSHELL_AUMID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const PROMPT_TAG = "pi-prompt";
const PROMPT_GROUP = "pi";

let cachedPs: string | null | undefined;

function resolvePowerShell(): string | null {
  if (cachedPs !== undefined) return cachedPs;
  cachedPs = null;
  if (process.platform === "linux" && existsSync("/mnt/c/Windows")) {
    for (const p of PS_CANDIDATES) {
      if (existsSync(p)) {
        cachedPs = p;
        return cachedPs;
      }
    }
    cachedPs = "powershell.exe"; // 交给 PATH（WSL 互操作）
  }
  return cachedPs;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

const PS_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
  "[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
];

/** 用 UTF-16LE + -EncodedCommand 调用 PowerShell，避免中文乱码。 */
function runPowerShell(lines: string[]): boolean {
  const ps = resolvePowerShell();
  if (!ps) return false;
  const script = lines.join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    const child = spawn(
      ps,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { stdio: "ignore", detached: true, windowsHide: true },
    );
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, 10000);
    child.on("exit", () => clearTimeout(timer));
    child.on("error", () => clearTimeout(timer));
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export type ToastOptions = {
  title: string;
  body: string[];
  aumid?: string;
  silent?: boolean;
  /** "long" 约停留 25 秒，适合"等你操作"类提醒 */
  duration?: "short" | "long";
  /** 同一 tag+group 的通知可被 removeToast 撤回 */
  tag?: string;
  group?: string;
};

/** 发送一条 Windows Toast 通知（fire-and-forget，不阻塞 pi）。 */
export function sendWindowsToast(opts: ToastOptions): boolean {
  const lines = opts.body
    .filter((l) => l && l.trim().length > 0)
    .map((l) => `      <text>${xmlEscape(l)}</text>`)
    .join("\n");

  const xml = `<toast duration="${opts.duration ?? "short"}" activationType="foreground">
  <visual>
    <binding template="ToastGeneric">
      <text>${xmlEscape(opts.title)}</text>
${lines}
    </binding>
  </visual>
${opts.silent ? '  <audio silent="true" />\n' : ""}</toast>`;

  const aumid = opts.aumid ?? POWERSHELL_AUMID;
  const xmlB64 = Buffer.from(xml, "utf8").toString("base64");

  return runPowerShell([
    ...PS_PRELUDE,
    `$doc = New-Object Windows.Data.Xml.Dom.XmlDocument`,
    `$doc.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${xmlB64}')))`,
    `$toast = New-Object Windows.UI.Notifications.ToastNotification $doc`,
    ...(opts.tag ? [`$toast.Tag = ${psQuote(opts.tag)}`] : []),
    ...(opts.group ? [`$toast.Group = ${psQuote(opts.group)}`] : []),
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(aumid)}).Show($toast)`,
  ]);
}

/** 从通知中心撤回指定 tag/group 的通知（用户已经完成选择了）。 */
export function removeWindowsToast(tag: string, group: string, aumid = POWERSHELL_AUMID): boolean {
  return runPowerShell([
    "$ErrorActionPreference = 'SilentlyContinue'",
    PS_PRELUDE[1],
    `[Windows.UI.Notifications.ToastNotificationManager]::History.Remove(${psQuote(tag)}, ${psQuote(group)}, ${psQuote(aumid)})`,
  ]);
}

// ------------------------------------------------------------------ 文本处理

function extractText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b as { type?: string })?.type === "text")
      .map((b) => String((b as { text?: string }).text ?? ""))
      .join("\n");
  }
  return "";
}

/** Markdown → 适合通知显示的纯文本 */
function toPlainText(md: string): string {
  let s = md;
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^\s{0,3}([-*+]|\d+[.)])\s+/gm, "");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/(^|\s)\*([^*\n]+)\*/g, "$1$2");
  s = s.replace(/^\s*[-*_]{3,}\s*$/gm, "");
  s = s.replace(/\|/g, " ");
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{2,}/g, "\n");
  return s.trim();
}

function summarize(text: string, maxLines = 2, maxChars = 170): string {
  const plain = toPlainText(text);
  if (!plain) return "";
  const lines = plain
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .map((l) => (l.length > maxChars ? l.slice(0, maxChars - 1) + "…" : l));
  return lines.join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}

function shrink(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/**
 * 从交互工具的入参里挖出"问了什么 + 有哪些选项"。
 * 兼容 {question, options:[{label}]}、{questions:[{header,question,options}]} 等常见形状。
 */
export function extractPromptContent(input: unknown): { text: string; options: string[] } {
  const out: { text: string; options: string[] } = { text: "", options: [] };
  const TEXT_KEYS = ["question", "prompt", "title", "message", "text", "header", "query"];
  const OPTION_KEYS = ["options", "choices", "items", "variants", "select"];

  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 5) return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 3)) visit(item, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (!out.text) {
      for (const k of TEXT_KEYS) {
        const v = obj[k];
        if (typeof v === "string" && v.trim()) {
          out.text = v.trim();
          break;
        }
      }
    }
    if (out.options.length === 0) {
      for (const k of OPTION_KEYS) {
        const v = obj[k];
        if (Array.isArray(v) && v.length > 0) {
          out.options = v
            .slice(0, 6)
            .map((o) =>
              typeof o === "string"
                ? o
                : String(
                    (o as Record<string, unknown>)?.label ??
                      (o as Record<string, unknown>)?.title ??
                      (o as Record<string, unknown>)?.value ??
                      (o as Record<string, unknown>)?.text ??
                      "",
                  ),
            )
            .filter(Boolean);
          break;
        }
      }
    }
    if (out.text && out.options.length > 0) return; // 够了，别挖太深
    for (const v of Object.values(obj)) visit(v, depth + 1);
  };

  visit(input, 0);
  return out;
}

// ---------------------------------------------------------------------- 状态

const STATE_FILE = join(homedir(), ".pi", "agent", "win-notify.json");

type State = { enabled: boolean };

function loadState(): State {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<State>;
    return { enabled: raw.enabled !== false };
  } catch {
    return { enabled: true };
  }
}

function saveState(state: State): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {}
}

// ---------------------------------------------------------------------- 扩展

const KIND_LABEL: Record<string, string> = {
  select: "选择",
  confirm: "确认",
  input: "输入",
  editor: "编辑",
  custom: "操作",
};

function interactiveToolPattern(): RegExp {
  const extra = (process.env.PI_WIN_NOTIFY_PROMPT_TOOLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("|");
  const base = "question|ask_|_ask|ask$|confirm|approv|elicit|interactive|prompt_user|user_input";
  return new RegExp(extra ? `(${base}|${extra})` : `(${base})`, "i");
}

export default function (pi: any) {
  const DEBUG =
    process.env.PI_WIN_NOTIFY_DEBUG === "1" || process.env.PI_WIN_NOTIFY_DEBUG === "true";
  const debug = (...a: unknown[]) => {
    if (DEBUG) console.error("[win-notify]", ...a);
  };
  debug("loaded; powershell =", resolvePowerShell());

  let state = loadState();
  let lastReply = "";
  let lastStopReason = "stop";
  let turnCount = 0;
  let runStartedAt = 0;
  let lastNotifiedAt = 0;
  let lastPromptAt = 0;
  let promptToastShown = false;
  let recentPrompt: { text: string; options: string[]; at: number } | null = null;

  const enabledNow = () => state.enabled && process.env.PI_WIN_NOTIFY !== "off";

  function notify(ctx: any, body: string[], title?: string, silent = false) {
    const name = basename(ctx?.cwd || process.cwd());
    return sendWindowsToast({
      title: title ?? `Pi · ${name}`,
      body,
      silent,
    });
  }

  /**
   * "等你操作" 提醒：long 时长 + 可撤回。
   * tool_call 与 ui_prompt_start 常常成对触发，用 3 秒窗口去重。
   */
  function notifyPrompt(ctx: any, title: string, body: string[]): boolean {
    const now = Date.now();
    if (now - lastPromptAt < 3000) return false;
    lastPromptAt = now;
    promptToastShown = true;
    debug("notify prompt:", title);
    return sendWindowsToast({
      title,
      body,
      duration: "long",
      tag: PROMPT_TAG,
      group: PROMPT_GROUP,
    });
  }

  function clearPromptToast() {
    if (!promptToastShown) return;
    promptToastShown = false;
    debug("remove prompt toast");
    removeWindowsToast(PROMPT_TAG, PROMPT_GROUP);
  }

  // ------------------------------------------------------------ 回复完成

  pi.on("session_start", async () => {
    lastReply = "";
    lastStopReason = "stop";
    turnCount = 0;
    runStartedAt = 0;
    promptToastShown = false;
  });

  pi.on("before_agent_start", async () => {
    runStartedAt = Date.now();
    turnCount = 0;
    lastReply = "";
    lastStopReason = "stop";
    clearPromptToast(); // 用户已回答，撤掉"等你操作"提醒
  });

  pi.on("turn_end", async () => {
    turnCount += 1;
  });

  // agent_end 在自动重试/压缩重试时会再次触发，每次都覆盖为最新结果
  pi.on("agent_end", async (event: any) => {
    const msgs = Array.isArray(event?.messages) ? event.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role !== "assistant") continue;
      const text = extractText(m);
      if (text.trim()) lastReply = text;
      lastStopReason = String(m?.stopReason ?? "stop");
      break;
    }
  });

  pi.on("agent_settled", async (_event: any, ctx: any) => {
    debug("agent_settled; hasUI =", ctx?.hasUI, "enabled =", enabledNow());
    clearPromptToast();
    if (!enabledNow()) return;
    if (!ctx?.hasUI) return; // headless / -p 模式不打扰
    const now = Date.now();
    if (now - lastNotifiedAt < 1000) return; // 去抖
    lastNotifiedAt = now;

    const elapsed = runStartedAt ? formatDuration(now - runStartedAt) : "";
    const modelId = ctx?.model?.id ? String(ctx.model.id) : "";
    const meta = [elapsed && `⏱ ${elapsed}`, turnCount > 0 && `${turnCount} 轮`, modelId]
      .filter(Boolean)
      .join(" · ");

    const status = lastStopReason;
    const title =
      status === "aborted"
        ? "Pi · 已中断"
        : status === "error"
          ? "Pi · ⚠️ 出错了"
          : `Pi · ${basename(ctx.cwd || process.cwd())}`;
    const summary =
      summarize(lastReply) ||
      (status === "aborted" ? "已按你的要求停下" : "已完成，等你指示 ✨");

    debug("notify done:", title, "|", status);
    notify(ctx, [summary, meta], title, status === "aborted");
    runStartedAt = 0;
  });

  // ------------------------------------------------------ 等你操作（UI 交互）

  pi.on("ui_prompt_start", async (event: any, ctx: any) => {
    if (!enabledNow() || !ctx?.hasUI) return;
    const kind = String(event?.kind ?? "custom");
    const label = KIND_LABEL[kind] ?? "操作";
    const title = event?.title ? String(event.title) : "";
    debug("ui_prompt_start:", kind, title);
    // 没有自带标题时（如 custom），复用刚刚 tool_call 里挖到的问题文本
    const reuse =
      !title && recentPrompt && Date.now() - recentPrompt.at < 5000 ? recentPrompt : null;
    notifyPrompt(
      ctx,
      `Pi · 等你${label}`,
      [
        shrink(title || reuse?.text || `Pi 发起了${label}请求`, 110),
        reuse?.options.length ? shrink(reuse.options.slice(0, 4).join("  ·  "), 90) : "",
        "切回终端完成操作",
      ],
    );
  });

  pi.on("ui_prompt_end", async () => {
    clearPromptToast();
  });

  // 兜底：部分交互工具直接渲染 TUI，不一定走 ctx.ui.*，用工具名兜住
  pi.on("tool_call", async (event: any, ctx: any) => {
    const name = String(event?.toolName ?? "");
    if (!name) return;
    debug("tool_call:", name);
    if (!enabledNow() || !ctx?.hasUI) return;
    if (!interactiveToolPattern().test(name)) return;

    // 把工具入参里的问题和选项挖出来，通知里直接显示
    const { text, options } = extractPromptContent(event?.input);
    recentPrompt = { text, options, at: Date.now() };

    const body = [
      shrink(text || `Pi 调用了 ${name}，正在等你`, 110),
      options.length ? shrink(options.slice(0, 4).join("  ·  "), 90) : "",
      "切回终端完成选择",
    ];
    notifyPrompt(ctx, "Pi · 需要你的输入", body);
  });

  // ------------------------------------------------------------------ 命令

  pi.registerCommand("win-notify", {
    description: "Windows 右下角通知：on | off | test",
    handler: async (args: string, ctx: any) => {
      const arg = (args || "").trim().toLowerCase();

      if (arg === "on" || arg === "off") {
        state = { enabled: arg === "on" };
        saveState(state);
        ctx.ui.notify(`win-notify: ${arg}`, "info");
        if (state.enabled) notify(ctx, ["通知已开启", "回复完成 / 需要你操作时会在这里提醒"]);
        return;
      }

      if (arg === "test") {
        notify(ctx, [summarize(lastReply) || "这是一条测试通知", "⏱ 0.1s · 测试"]);
        const ok2 = sendWindowsToast({
          title: "Pi · 等你选择",
          body: ["测试：这类通知会停留约 25 秒", "切回终端完成选择"],
          duration: "long",
          tag: PROMPT_TAG,
          group: PROMPT_GROUP,
        });
        ctx.ui.notify(ok2 ? "已发送两条测试通知" : "发送失败：未找到 PowerShell", ok2 ? "info" : "error");
        return;
      }

      const ok = notify(ctx, [
        `当前状态：${enabledNow() ? "开启" : "关闭"}`,
        "回复完成后弹出右下角通知",
      ]);
      ctx.ui.notify(
        [
          `状态：${state.enabled ? "on" : "off"}${process.env.PI_WIN_NOTIFY === "off" ? "（被 PI_WIN_NOTIFY=off 覆盖）" : ""}`,
          `PowerShell: ${resolvePowerShell() ?? "未找到"}`,
          `状态文件: ${STATE_FILE}`,
          `测试通知: ${ok ? "已发送" : "发送失败"}`,
        ].join("  |  "),
        ok ? "info" : "warn",
      );
    },
  });
}

// 允许直接运行本文件做自检：node ~/.pi/agent/extensions/win-notify.ts [文本]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = process.argv.slice(2).join(" ") || "自检通知：我是 Pi，你好呀 👋";
  const ok = sendWindowsToast({ title: "Pi · self-test", body: [text, "直接运行扩展文件的自检"] });
  console.log(ok ? "sent" : "failed: powershell not found");
}
