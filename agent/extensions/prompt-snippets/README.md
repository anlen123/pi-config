# Prompt Snippets

Mix-and-match single-purpose prompt rules that are prepended or appended to
your message when you send it. Unlike skills, each snippet is a tiny,
standalone instruction — toggle exactly the ones you want per message.

## Usage

- Press **alt+k** or run **/snippets** to open the toggle menu.
  - `up`/`down` to navigate, `space` to toggle, `enter` to apply, `esc` to cancel.
  - `tab` previews the highlighted snippet (name, placement, order, filename,
    and full body; `up`/`down` scroll long bodies). `tab` or `esc` returns to
    the list with your cursor position preserved.
  - The menu is framed with top/bottom border lines and scrolls when the list
    exceeds the viewport (max height adapts to your terminal), with
    `↑ n more` / `↓ n more` indicators when clipped.
- Active snippets show up as a widget above the editor:
  - `↑ prepend: ...` (accent color) — inserted before your message
  - `↓ append: ...` (warning color) — inserted after your message
- When you send a message, active snippet bodies are merged into the message
  text: prepend group (sorted by `order`) → your text → append group (sorted
  by `order`), separated by blank lines.
- **空回车直接发送**：有激活片段且输入框为空时，直接按 Enter 会发送合并后的
  片段内容（无需输入任何文字）。编辑器有文字、agent 忙碌或未选任何片段时，
  Enter 行为不变。
- Toggles reset to **all off** after each send and at session start.

Included snippets also cover continuing interrupted work, provider onboarding, verification-first workflows, and orchestration.
The **增加模型供应商** snippet instructs the agent to request missing `baseUrl`/API key values, verify the provider and at least one model before writing `models.json`, and avoid adding a provider when every model check fails.

## Snippet files

Snippets live in `snippets/` next to `index.ts` — one markdown file each,
with frontmatter:

```markdown
---
name: Concise
description: Keep answers short and to the point
placement: prepend
order: 10
---
Keep your response concise. Skip preamble and unnecessary explanation.
```

| Field | Required | Notes |
|---|---|---|
| `name` | no | Display name; defaults to the filename without `.md` |
| `description` | no | Shown next to the name in the toggle menu |
| `placement` | no | `prepend` or `append` (default: `append`) |
| `order` | no | Number; sorts snippets within their group, in the menu and in the applied text (default: `9999`, ties broken by name) |

Files are re-scanned every time the menu opens and every time a message is
sent, so edits take effect immediately — no `/reload` needed.
