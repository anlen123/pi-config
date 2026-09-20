import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PS_CANDIDATES = [
  "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  "/mnt/c/Program Files/PowerShell/7/pwsh.exe",
];
const POWERSHELL_AUMID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
const STATE_FILE = join(homedir(), ".pi", "agent", "win-notify.json");
const PS_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
  "[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
];

function resolvePowerShell(): string | null {
  if (process.platform !== "linux" || (!process.env.WSL_DISTRO_NAME && !existsSync("/mnt/c/Windows"))) return null;
  for (const candidate of PS_CANDIDATES) if (existsSync(candidate)) return candidate;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of ["powershell.exe", "pwsh.exe"]) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function xmlEscape(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

function psQuote(text: string): string { return "'" + text.replace(/'/g, "''") + "'"; }

type ToastResult = { ok: true } | { ok: false; error: string };
type ToastOptions = {
  title: string;
  body: string[];
  aumid?: string;
  silent?: boolean;
  duration?: "short" | "long";
  tag?: string;
  group?: string;
};

let powershellQueue: Promise<ToastResult> = Promise.resolve({ ok: true });
function runPowerShell(lines: string[]): Promise<ToastResult> {
  const execute = (): Promise<ToastResult> => new Promise((resolve) => {
    const ps = resolvePowerShell();
    if (!ps) { resolve({ ok: false, error: "未找到 WSL Windows PowerShell" }); return; }
    const encoded = Buffer.from(lines.join("\n"), "utf16le").toString("base64");
    execFile(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { encoding: "utf8", timeout: 10000, windowsHide: true, maxBuffer: 512 * 1024 },
      (error, _stdout, stderr) => resolve(error
        ? { ok: false, error: error.killed ? "PowerShell 超时或被终止" : `PowerShell ${error.code ?? "失败"}: ${shrink(stderr || error.message, 240)}` }
        : { ok: true }));
  });
  powershellQueue = powershellQueue.then(execute, execute).catch((error): ToastResult => ({ ok: false, error: String(error) }));
  return powershellQueue;
}

function sendWindowsToast(opts: ToastOptions): Promise<ToastResult> {
  const body = opts.body.filter((line) => line.trim()).map((line) => `<text>${xmlEscape(line)}</text>`).join("\n");
  const xml = `<toast duration="${opts.duration ?? "short"}" activationType="foreground"><visual><binding template="ToastGeneric"><text>${xmlEscape(opts.title)}</text>${body}</binding></visual>${opts.silent ? '<audio silent="true" />' : ""}</toast>`;
  const xmlB64 = Buffer.from(xml, "utf8").toString("base64");
  return runPowerShell([...PS_PRELUDE, "$doc = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$doc.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${xmlB64}')))`,
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $doc",
    ...(opts.tag ? [`$toast.Tag = ${psQuote(opts.tag)}`] : []),
    ...(opts.group ? [`$toast.Group = ${psQuote(opts.group)}`] : []),
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(opts.aumid ?? POWERSHELL_AUMID)}).Show($toast)`]);
}

function removeWindowsToast(tag: string, group: string, aumid = POWERSHELL_AUMID): Promise<ToastResult> {
  return runPowerShell([...PS_PRELUDE, `[Windows.UI.Notifications.ToastNotificationManager]::History.Remove(${psQuote(tag)}, ${psQuote(group)}, ${psQuote(aumid)})`]);
}

function extractText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => String(block.text ?? "")).join("\n");
}
function toPlainText(md: string): string {
  return md.replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|\s)\*([^*\n]+)\*/g, "$1$2")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "").replace(/\|/g, " ").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}
function summarize(text: string): string { return toPlainText(text).split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 2).map((line) => shrink(line, 170)).join("\n"); }
function shrink(text: string, limit: number): string { const plain = text.replace(/\s+/g, " ").trim(); return plain.length > limit ? plain.slice(0, limit - 1) + "…" : plain; }
function formatDuration(ms: number): string { if (ms < 1000) return "<1s"; const seconds = ms / 1000; if (seconds < 60) return `${seconds.toFixed(1)}s`; const rounded = Math.round(seconds); return `${Math.floor(rounded / 60)}m${rounded % 60}s`; }

function extractPromptContent(input: unknown): { text: string; options: string[] } {
  const result = { text: "", options: [] as string[] };
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 5) return;
    if (Array.isArray(node)) { for (const item of node.slice(0, 3)) visit(item, depth + 1); return; }
    const object = node as Record<string, unknown>;
    if (!result.text) for (const key of ["question", "prompt", "title", "message", "text", "header", "query"]) {
      const value = object[key]; if (typeof value === "string" && value.trim()) { result.text = value.trim(); break; }
    }
    if (!result.options.length) for (const key of ["options", "choices", "items", "variants", "select"]) {
      const value = object[key]; if (!Array.isArray(value) || !value.length) continue;
      result.options = value.slice(0, 6).map((option) => typeof option === "string" ? option : String((option as any)?.label ?? (option as any)?.title ?? (option as any)?.value ?? (option as any)?.text ?? "")).filter(Boolean); break;
    }
    if (result.text && result.options.length) return;
    for (const value of Object.values(object)) visit(value, depth + 1);
  };
  visit(input, 0); return result;
}

type State = { enabled: boolean };
function loadState(): State { try { return { enabled: JSON.parse(readFileSync(STATE_FILE, "utf8")).enabled !== false }; } catch { return { enabled: true }; } }

export default function (pi: ExtensionAPI) {
  const debug = (...args: unknown[]): void => { if (["1", "true"].includes(process.env.PI_WIN_NOTIFY_DEBUG ?? "")) console.error("[win-notify]", ...args); };
  const extraPatterns = (process.env.PI_WIN_NOTIFY_PROMPT_TOOLS ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const promptPattern = new RegExp(["question|ask_|_ask|ask$|confirm|approv|elicit|interactive|prompt_user|user_input", ...extraPatterns].join("|"), "i");
  const promptTag = `pi-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const promptGroup = "pi";
  const activePrompts = new Set<string>();
  let promptToastShown = false;
  let state = loadState();
  let lastReply = "";
  let turnCount = 0;
  let runStartedAt = 0;
  const enabledNow = (): boolean => state.enabled && process.env.PI_WIN_NOTIFY !== "off";

  async function deliver(ctx: ExtensionContext, opts: ToastOptions): Promise<ToastResult> {
    if (process.env.PI_WIN_NOTIFY === "off") return { ok: false, error: "被 PI_WIN_NOTIFY=off 禁用" };
    const result = await sendWindowsToast(opts); debug("toast", result.ok ? "accepted" : result.error);
    if (!result.ok && ctx.hasUI) ctx.ui.notify(`win-notify: ${result.error}`, "warning");
    return result;
  }
  async function clearPromptToast(ctx: ExtensionContext): Promise<void> {
    if (!promptToastShown) return; promptToastShown = false;
    const result = await removeWindowsToast(promptTag, promptGroup); if (!result.ok && ctx.hasUI) ctx.ui.notify(`win-notify: 撤回失败: ${result.error}`, "warning");
  }
  async function notifyPrompt(key: string, ctx: ExtensionContext, title: string, body: string[]): Promise<void> {
    if (!enabledNow() || !ctx.hasUI || activePrompts.has(key)) return;
    activePrompts.add(key); promptToastShown = true; await deliver(ctx, { title, body, duration: "long", tag: promptTag, group: promptGroup });
  }
  async function endPrompt(key: string, ctx: ExtensionContext): Promise<void> { activePrompts.delete(key); if (!activePrompts.size) await clearPromptToast(ctx); }
  async function reset(ctx: ExtensionContext): Promise<void> { activePrompts.clear(); await clearPromptToast(ctx); lastReply = ""; turnCount = 0; runStartedAt = 0; }

  pi.on("session_start", async (_event, ctx) => { await reset(ctx); });
  pi.on("session_before_switch", async (_event, ctx) => { await reset(ctx); });
  pi.on("session_before_fork", async (_event, ctx) => { await reset(ctx); });
  pi.on("session_tree", async (_event, ctx) => { await reset(ctx); });
  pi.on("session_shutdown", async (_event, ctx) => { await reset(ctx); });
  pi.on("before_agent_start", async (_event, ctx) => { if (!runStartedAt) { runStartedAt = Date.now(); turnCount = 0; lastReply = ""; } activePrompts.clear(); await clearPromptToast(ctx); });
  pi.on("turn_end", (event) => { turnCount = Math.max(turnCount, event.turnIndex + 1); if (event.message.role === "assistant") lastReply = extractText(event.message); });
  pi.on("agent_settled", async (_event, ctx) => {
    const startedAt = runStartedAt; const turns = turnCount; runStartedAt = 0; turnCount = 0; activePrompts.clear(); await clearPromptToast(ctx);
    if (!enabledNow() || !ctx.hasUI) return;
    const title = `Pi · ${basename(ctx.cwd)}`; const summary = summarize(lastReply) || "已完成，等你指示";
    const meta = [startedAt ? formatDuration(Date.now() - startedAt) : "", turns ? `${turns} 轮` : "", ctx.model?.id].filter(Boolean).join(" · ");
    await deliver(ctx, { title, body: [summary, meta] });
  });
  pi.on("tool_execution_start", async (event, ctx) => { if (promptPattern.test(event.toolName)) { const prompt = extractPromptContent(event.args); await notifyPrompt(`tool:${event.toolCallId}`, ctx, "Pi · 需要你的输入", [shrink(prompt.text || `Pi 调用了 ${event.toolName}，正在等你`, 110), shrink(prompt.options.slice(0, 4).join("  · "), 90), "切回终端完成选择"]); } });
  pi.on("tool_execution_end", async (event, ctx) => { await endPrompt(`tool:${event.toolCallId}`, ctx); });
  pi.on("ui_prompt_start", async (event, ctx) => { await notifyPrompt(`ui:${event.kind}`, ctx, "Pi · 等你选择", [shrink(event.title || "Pi 正在等待你的输入", 110), "切回终端完成选择"]); });
  pi.on("ui_prompt_end", async (event, ctx) => { await endPrompt(`ui:${event.kind}`, ctx); });

  pi.registerCommand("win-notify", {
    description: "Windows 右下角通知：status | on | off | test",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        const nextState = { enabled: arg === "on" };
        try { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2) + "\n", "utf8"); }
        catch (error) { ctx.ui.notify(`win-notify: 保存状态失败: ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
        state = nextState; ctx.ui.notify(`win-notify: ${arg}${process.env.PI_WIN_NOTIFY === "off" ? "（被 PI_WIN_NOTIFY=off 覆盖）" : ""}`, "info");
        if (!state.enabled) { activePrompts.clear(); await clearPromptToast(ctx); } else if (enabledNow()) await deliver(ctx, { title: `Pi · ${basename(ctx.cwd)}`, body: ["通知已开启", "回复完成 / 需要你操作时会在这里提醒"] }); return;
      }
      if (arg === "test") {
        const done = await deliver(ctx, { title: `Pi · ${basename(ctx.cwd)}`, body: [summarize(lastReply) || "这是一条测试通知", "测试"] });
        promptToastShown = process.env.PI_WIN_NOTIFY !== "off";
        const prompt = await deliver(ctx, { title: "Pi · 等你选择", body: ["测试：这类通知会停留约 25 秒", "切回终端完成选择"], duration: "long", tag: promptTag, group: promptGroup });
        ctx.ui.notify(done.ok && prompt.ok ? "Windows 已接受两条测试通知" : "测试通知未全部发送成功", done.ok && prompt.ok ? "info" : "error"); return;
      }
      if (arg && arg !== "status") { ctx.ui.notify("用法：/win-notify [status|on|off|test]", "warning"); return; }
      ctx.ui.notify([`状态：${state.enabled ? "on" : "off"}${process.env.PI_WIN_NOTIFY === "off" ? "（被 PI_WIN_NOTIFY=off 覆盖）" : ""}`, `PowerShell: ${resolvePowerShell() ?? "未找到"}`, `状态文件: ${STATE_FILE}`, "交互提醒：UI prompt、交互工具和执行审批"].join("  |  "), "info");
      if (!arg) await deliver(ctx, { title: `Pi · ${basename(ctx.cwd)}`, body: [`当前状态：${enabledNow() ? "开启" : "关闭"}`, "回复完成后弹出右下角通知"] });
    },
  });
}
