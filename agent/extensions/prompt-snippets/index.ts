import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type EditorComponent } from "@earendil-works/pi-tui";

type Placement = "prepend" | "append";
interface Snippet { id: string; name: string; description: string; placement: Placement; order: number; body: string; }
interface EditorWithInput extends EditorComponent { handleInput(data: string): void; getText(): string; __snippetsEmptyEnterHooked?: boolean; }

const extensionDir = dirname(fileURLToPath(import.meta.url));
const snippetsDir = join(extensionDir, "snippets");
const WIDGET_ID = "prompt-snippets";

function parseSnippet(filename: string, raw: string): Snippet | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (entry) meta[entry[1].toLowerCase()] = entry[2].trim().replace(/^["']|["']$/g, "");
  }
  const body = match[2].trim();
  if (!body) return null;
  const parsedOrder = Number.parseInt(meta.order ?? "", 10);
  return { id: filename, name: meta.name || filename.replace(/\.md$/i, ""), description: meta.description ?? "", placement: meta.placement === "prepend" ? "prepend" : "append", order: Number.isFinite(parsedOrder) ? parsedOrder : 9999, body };
}

function loadSnippets(): Snippet[] {
  if (!existsSync(snippetsDir)) return [];
  const snippets: Snippet[] = [];
  for (const file of readdirSync(snippetsDir)) {
    if (!file.toLowerCase().endsWith(".md")) continue;
    try { const snippet = parseSnippet(file, readFileSync(join(snippetsDir, file), "utf8")); if (snippet) snippets.push(snippet); } catch { /* Ignore unreadable snippet files. */ }
  }
  const byOrder = (a: Snippet, b: Snippet): number => a.order - b.order || a.name.localeCompare(b.name);
  return [...snippets.filter((snippet) => snippet.placement === "prepend").sort(byOrder), ...snippets.filter((snippet) => snippet.placement === "append").sort(byOrder)];
}

function getEditor(component: EditorComponent): EditorWithInput | undefined {
  if (!("handleInput" in component) || !("getText" in component)) return undefined;
  const editor = component as unknown as Partial<EditorWithInput>;
  return typeof editor.handleInput === "function" && typeof editor.getText === "function" ? editor as EditorWithInput : undefined;
}

export default function (pi: ExtensionAPI) {
  let snippets: Snippet[] = [];
  let enabled = new Set<string>();

  function updateWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const active = snippets.filter((snippet) => enabled.has(snippet.id));
    const prepends = active.filter((snippet) => snippet.placement === "prepend");
    const appends = active.filter((snippet) => snippet.placement === "append");
    if (prepends.length === 0 && appends.length === 0) { ctx.ui.setWidget(WIDGET_ID, undefined); return; }
    const lines: string[] = [];
    if (prepends.length > 0) lines.push(ctx.ui.theme.fg("accent", `↑ prepend: ${prepends.map((snippet) => snippet.name).join(" · ")}`));
    if (appends.length > 0) lines.push(ctx.ui.theme.fg("warning", `↓ append: ${appends.map((snippet) => snippet.name).join(" · ")}`));
    ctx.ui.setWidget(WIDGET_ID, lines);
  }

  function trySendActiveSnippets(data: string, editor: EditorWithInput, ctx: ExtensionContext): boolean {
    if (!matchesKey(data, Key.enter) || enabled.size === 0 || editor.getText().trim().length > 0 || !ctx.isIdle()) return false;
    const active = snippets.filter((snippet) => enabled.has(snippet.id));
    if (active.length === 0) return false;
    enabled = new Set();
    updateWidget(ctx);
    void pi.sendUserMessage(active.map((snippet) => snippet.body).join("\n\n")).catch(() => {});
    return true;
  }

  function installEmptyEnter(ctx: ExtensionContext): void {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const previousFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const component = previousFactory ? previousFactory(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
      const editor = getEditor(component);
      if (!editor || editor.__snippetsEmptyEnterHooked) return component;
      editor.__snippetsEmptyEnterHooked = true;
      const originalHandleInput = editor.handleInput.bind(editor);
      editor.handleInput = (data: string): void => {
        try { if (trySendActiveSnippets(data, editor, ctx)) return; } catch { /* Keep normal editor behavior if this hook fails. */ }
        originalHandleInput(data);
      };
      return component;
    });
  }

  async function openMenu(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") { ctx.ui.notify("Snippet menu requires interactive mode", "warning"); return; }
    snippets = loadSnippets();
    enabled = new Set([...enabled].filter((id) => snippets.some((snippet) => snippet.id === id)));
    if (snippets.length === 0) { ctx.ui.notify(`No snippets found in ${snippetsDir}`, "warning"); updateWidget(ctx); return; }
    const working = new Set(enabled);
    const confirmed = await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
      const prepends = snippets.filter((snippet) => snippet.placement === "prepend");
      const appends = snippets.filter((snippet) => snippet.placement === "append");
      const items = [...prepends, ...appends];
      let mode: "list" | "preview" = "list";
      let cursor = 0;
      let listScroll = 0;
      let previewScroll = 0;
      const itemRow = (snippet: Snippet, index: number, width: number): string => {
        const pointer = index === cursor ? theme.fg("accent", "> ") : "  ";
        const checkbox = working.has(snippet.id) ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
        const description = snippet.description ? theme.fg("dim", ` — ${snippet.description}`) : "";
        return truncateToWidth(`${pointer}${checkbox} ${theme.bold(snippet.name)}${description}`, width);
      };
      const view = (lines: string[], scroll: number, maximum: number, focus?: number): { lines: string[]; scroll: number } => {
        const clipped = lines.length > maximum;
        const capacity = clipped ? Math.max(1, maximum - 2) : maximum;
        let nextScroll = Math.min(Math.max(0, scroll), Math.max(0, lines.length - capacity));
        if (focus !== undefined) {
          if (focus < nextScroll) nextScroll = focus;
          else if (focus >= nextScroll + capacity) nextScroll = focus - capacity + 1;
        }
        const visible = lines.slice(nextScroll, nextScroll + capacity);
        if (!clipped) return { lines: visible, scroll: nextScroll };
        const below = lines.length - (nextScroll + capacity);
        return { lines: [nextScroll > 0 ? theme.fg("dim", `  ↑ ${nextScroll} more`) : "", ...visible, below > 0 ? theme.fg("dim", `  ↓ ${below} more`) : ""], scroll: nextScroll };
      };
      return {
        render(width: number): string[] {
          const maximum = Math.max(5, tui.terminal.rows - 10);
          let content: string[];
          let title: string;
          let hints: string;
          if (mode === "list") {
            const rows = [theme.fg("dim", "↑ PREPEND — added before your message"), ...prepends.map((snippet, index) => itemRow(snippet, index, width)), "", theme.fg("dim", "↓ APPEND — added after your message"), ...appends.map((snippet, index) => itemRow(snippet, prepends.length + index, width))];
            const rowIndexes = [...prepends.map((_snippet, index) => index + 1), ...appends.map((_snippet, index) => prepends.length + index + 3)];
            const result = view(rows, listScroll, maximum, rowIndexes[cursor]); content = result.lines; listScroll = result.scroll; title = "Prompt snippets"; hints = "↑↓ navigate • Space toggle • Tab preview • Enter apply • Esc cancel";
          } else {
            const snippet = items[cursor];
            const rows = [truncateToWidth(theme.bold(snippet.name), width), truncateToWidth(theme.fg("dim", `${snippet.placement} · order ${snippet.order} · ${snippet.id}`), width), theme.fg("dim", "─".repeat(Math.min(width, 40))), ...snippet.body.split("\n").flatMap((line) => wrapTextWithAnsi(line, width).map((wrapped) => truncateToWidth(wrapped, width)))];
            const result = view(rows, previewScroll, maximum); content = result.lines; previewScroll = result.scroll; title = `Preview: ${snippet.name}`; hints = "↑↓ scroll • Tab/Esc back";
          }
          return [theme.fg("accent", "─".repeat(width)), truncateToWidth(` ${theme.fg("accent", theme.bold(title))}`, width), "", ...content, "", truncateToWidth(theme.fg("dim", ` ${hints}`), width), theme.fg("accent", "─".repeat(width))];
        },
        invalidate(): void {},
        handleInput(data: string): void {
          if (mode === "preview") {
            if (matchesKey(data, Key.up)) { previewScroll--; tui.requestRender(); }
            else if (matchesKey(data, Key.down)) { previewScroll++; tui.requestRender(); }
            else if (matchesKey(data, Key.tab) || matchesKey(data, Key.escape)) { mode = "list"; tui.requestRender(); }
            return;
          }
          if (matchesKey(data, Key.up)) { cursor = (cursor - 1 + items.length) % items.length; tui.requestRender(); }
          else if (matchesKey(data, Key.down)) { cursor = (cursor + 1) % items.length; tui.requestRender(); }
          else if (matchesKey(data, Key.space)) { const id = items[cursor].id; if (working.has(id)) working.delete(id); else working.add(id); tui.requestRender(); }
          else if (matchesKey(data, Key.tab)) { mode = "preview"; previewScroll = 0; tui.requestRender(); }
          else if (matchesKey(data, Key.enter)) done(true);
          else if (matchesKey(data, Key.escape)) done(false);
        },
      };
    });
    if (confirmed) enabled = working;
    updateWidget(ctx);
  }

  pi.on("session_start", (_event, ctx) => { enabled = new Set(); snippets = loadSnippets(); if (!existsSync(snippetsDir)) mkdirSync(snippetsDir, { recursive: true }); updateWidget(ctx); installEmptyEnter(ctx); });
  pi.on("input", async (event, ctx) => {
    if (enabled.size === 0) return;
    snippets = loadSnippets();
    const active = snippets.filter((snippet) => enabled.has(snippet.id));
    enabled = new Set(); updateWidget(ctx);
    if (active.length === 0) return;
    return { action: "transform", text: [...active.filter((snippet) => snippet.placement === "prepend").map((snippet) => snippet.body), event.text, ...active.filter((snippet) => snippet.placement === "append").map((snippet) => snippet.body)].join("\n\n") };
  });
  pi.registerShortcut("alt+k", { description: "Toggle prompt snippets", handler: async (ctx) => { await openMenu(ctx); } });
  pi.registerCommand("snippets", { description: "Open the prompt snippet toggle menu", handler: async (_args, ctx) => { await openMenu(ctx); } });
}
