# Pi 环境还原清单（AI 执行指南）

> 本文件是给 **AI 助手** 执行的操作清单，不是给人阅读的说明。
> 人类用户只需在新机器启动 pi（或任意带终端工具的 AI），然后说：
>
> ```
> 请阅读 https://raw.githubusercontent.com/anlen123/pi-config/main/AI-RESTORE.md
> 并严格按照其中的步骤清单，帮我还原我的 pi 编码助手环境。
> ```
>
> 配置来源仓库（公开，无需任何认证）：
> **https://github.com/anlen123/pi-config**

---

## 0. 角色与规则（AI 必读）

你是系统管理员 AI。你的任务：**把当前机器上的 pi 编码助手环境还原为仓库中的配置**。

执行规则：

1. **先检测平台，再执行**：Linux 用 bash 命令，Windows 用 PowerShell 命令，禁止混用。
2. **每一步都要验证**：执行后检查结果是否符合「验证」要求；失败则按「异常处理」修复或降级，不要静默跳过。
3. **需要用户输入时停下询问**（见步骤 7：仅当仍缺占位符时才需要用户提供 Key），其余步骤自主完成。
4. **不要打印/记录 API 密钥**到任何日志或文件中。
5. **所有路径变量化**：下文 `PI_SRC` = 配置来源目录，`PI_AGENT` = pi 配置目标目录。
6. 全部完成后输出「还原报告」（见步骤 9）。

---

## 1. 检测平台与前置条件

### 1.1 平台检测

| 平台 | 检测命令 | 判定 |
|---|---|---|
| Linux | `uname -s` | 输出含 `Linux`（WSL 也算 Linux，继续用 bash） |
| Windows | `$env:OS` | 输出含 `Windows`（用 PowerShell） |

### 1.2 定义路径变量

- **Linux（含 WSL）**：
  - `PI_SRC="$HOME/pi-config"`
  - `PI_AGENT="$HOME/.pi/agent"`
- **Windows（PowerShell）**：
  - `$PI_SRC = "$env:USERPROFILE\pi-config"`
  - `$PI_AGENT = "$env:USERPROFILE\.pi\agent"`

### 1.3 前置检查

| 检查项 | Linux | Windows | 不满足时 |
|---|---|---|---|
| git | `git --version` | `git --version` | 改用「方式 B：下载 ZIP」（见 2.2） |
| pi 已安装 | `pi --version` | `pi --version` | 提示用户先安装：`npm install -g @earendil-works/pi-coding-agent`，装完再继续 |
| npm | `npm --version` | `npm --version` | 跳过步骤 6 的手动安装（pi 启动时会自动装 packages） |
| 网络 | `curl -sI https://github.com` | `curl.exe -sI https://github.com` | 停下列出缺失项，请用户解决或改用本地 ZIP |

---

## 2. 获取配置（步骤 2.1 与 2.2 二选一）

### 2.1 方式 A：git clone（推荐）

```bash
# Linux
git clone https://github.com/anlen123/pi-config.git "$HOME/pi-config"
```
```powershell
# Windows
git clone https://github.com/anlen123/pi-config.git "$env:USERPROFILE\pi-config"
```

### 2.2 方式 B：下载 ZIP（无 git 时）

```bash
# Linux
mkdir -p "$HOME/pi-config" && curl -L https://github.com/anlen123/pi-config/archive/refs/heads/main.zip -o /tmp/pi-config.zip
unzip -q /tmp/pi-config.zip -d "$HOME" && mv "$HOME/pi-config-main" "$HOME/pi-config"
```
```powershell
# Windows
Invoke-WebRequest https://github.com/anlen123/pi-config/archive/refs/heads/main.zip -OutFile "$env:TEMP\pi-config.zip"
Expand-Archive "$env:TEMP\pi-config.zip" "$env:USERPROFILE" -Force
Move-Item "$env:USERPROFILE\pi-config-main" "$env:USERPROFILE\pi-config" -Force
```

### ✅ 步骤 2 验证

- `PI_SRC` 下存在：`README.md`、`agent/`、`restore.sh`、`restore.ps1`、`INFO.txt`、`AI-RESTORE.md`
- 不存在则报错并重新获取，最多重试 2 次。

---

## 3. 备份现有配置（防误操作）

如果目标目录已存在且非空，先备份（**不删除原数据**）。

> ⚠️ **关键**：`sessions/` 是运行中的 pi 正在写入的会话目录，必须**保留在原位**，
> 否则 mv 之后运行中的 pi 追加会话日志会报 `ENOENT: no such file or directory`
> （文件路径已不存在）。因此备份采用「mv 后把 sessions/ 移回原位」的方式。

```bash
# Linux
if [ -d "$HOME/.pi/agent" ] && [ -n "$(ls -A "$HOME/.pi/agent" 2>/dev/null)" ]; then
  BAK="$HOME/.pi/agent.bak-$(date +%Y%m%d-%H%M%S)"
  mv "$HOME/.pi/agent" "$BAK"
  mkdir -p "$HOME/.pi/agent"
  [ -d "$BAK/sessions" ] && mv "$BAK/sessions" "$HOME/.pi/agent/sessions"
  echo "已备份到: $BAK（sessions/ 保留在原位）"
fi
```
```powershell
# Windows（同样：sessions/ 保留在原位）
if (Test-Path "$env:USERPROFILE\.pi\agent") {
  $bak = "$env:USERPROFILE\.pi\agent.bak-" + (Get-Date -Format yyyyMMdd-HHmmss)
  Move-Item "$env:USERPROFILE\.pi\agent" $bak
  New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.pi\agent" | Out-Null
  if (Test-Path "$bak\sessions") {
    Move-Item "$bak\sessions" "$env:USERPROFILE\.pi\agent\sessions"
  }
}
```

### ✅ 步骤 3 验证

- 原目录已被改名（存在 `.bak-*` 目录），或原本就不存在。
- 新目录下 `sessions/` 仍存在（旧会话历史未丢失；若原本就没有则忽略）。

---

## 4. 还原配置文件

```bash
# Linux
mkdir -p "$HOME/.pi/agent"
cp -a "$HOME/pi-config/agent/." "$HOME/.pi/agent/"
```
```powershell
# Windows
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.pi\agent" | Out-Null
Copy-Item "$env:USERPROFILE\pi-config\agent\*" "$env:USERPROFILE\.pi\agent" -Recurse -Force
```

### ⚠️ 不同步文件：模型 / 鉴权相关一律保留本机版本

**同步只覆盖** 插件（`extensions/`）、Skill（`skills/`）、MCP（`mcp/`）、脚本、`npm/package.json`，
以及 `settings.json` 的非模型字段。

下面这些**永远不要用仓库版本覆盖本机已有的**（本机没有时才安装仓库模板）：
`models.json`、`models-store.json`、`auth.json`，以及 `settings.json` 的
`defaultProvider` / `defaultModel` / `defaultThinkingLevel`。

```bash
# Linux：上面的 cp 之后，把本机旧版本还原回来（$BAK = 步骤 3 的备份目录）
for f in models.json models-store.json auth.json; do
  [ -f "$BAK/$f" ] && cp -a "$BAK/$f" "$HOME/.pi/agent/$f"
done
# settings.json 的默认模型字段保持本机值（其他字段用仓库版本）
python3 - "$BAK/settings.json" "$HOME/.pi/agent/settings.json" <<'PYEOF'
import json, sys
old = json.load(open(sys.argv[1], encoding="utf-8"))
new = json.load(open(sys.argv[2], encoding="utf-8"))
for k in ("defaultProvider", "defaultModel", "defaultThinkingLevel"):
    if k in old:
        new[k] = old[k]
json.dump(new, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYEOF
```
```powershell
# Windows：同样从 $bak 恢复
foreach ($f in @("models.json", "models-store.json", "auth.json")) {
  if (Test-Path "$bak\$f") { Copy-Item "$bak\$f" "$env:USERPROFILE\.pi\agent\$f" -Force }
}
```

> 用 `restore.sh` / `restore.ps1` 还原时脚本已内置这套逻辑，无需手工处理。

### ✅ 步骤 4 验证（全部必须存在）

| 路径（相对 `PI_AGENT`） | 说明 |
|---|---|
| `settings.json` | 全局设置（含 11 个 packages） |
| `models.json` | 自定义 provider/model（apiKey 为明文或 `PASTE_YOUR_...` 占位符；本机已有则保留本机，见步骤 7） |
| `models-store.json` | 模型存储 |
| `AGENTS.md` | 全局沟通规则（中文） |
| `keybindings.json` / `trust.json` / `pi-fff.json` | 快捷键 / 项目信任 / fff 设置 |
| `extensions/` | 8 个 ts 文件（model-info-footer、context-progress-bar、dedupe-status、deepseek-balance、deepseek-peak-status、herdr-agent-state、live-thinking、question）+ bash-guard/ 目录（依赖 shell-quote，见步骤 8）+ prompt-snippets/ 目录 + mcp/index.ts |
| `skills/` | 13 个目录 |
| `npm/package.json` + `npm/package-lock.json` | 包清单 |
| `git/` | git 包缓存 |
| `auth.json.example` | 明文密钥模板（值为 `PASTE_YOUR_...`，不是密钥本体） |

> **预期缺失**（正常现象，不要报错）：`auth.json`（明文密钥，步骤 7 处理；本机已有则不要覆盖）。
> `sessions/` 按步骤 3 已保留在原位（旧会话历史，不随仓库分发）。

---

## 5. 平台适配（bin/ 二进制）

仓库中的 `agent/bin/` 是 **Linux-x86_64** 的 fd/rg 二进制，仅当平台匹配时保留：

```bash
# Linux：仅当 系统=Linux 且 架构=x86_64 时保留，否则删除
if [ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" = "x86_64" ]; then
  echo "平台匹配，保留 bin/ (fd/rg)"
else
  rm -rf "$HOME/.pi/agent/bin"
  echo "平台不匹配，已删除 bin/；pi 会按需重新获取 fd/rg"
fi
```
```powershell
# Windows：直接删除（ELF 二进制不可用）
Remove-Item "$env:USERPROFILE\.pi\agent\bin" -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "已删除 Linux 版 fd/rg；pi 启动时按需获取"
```

### ✅ 步骤 5 验证

- Linux-x86_64：`bin/fd` 与 `bin/rg` 存在且可执行（`test -x`）。
- 其他平台：`bin/` 不存在。

---

## 6. 还原 MCP 配置（如存在）

`PI_SRC/mcp/` 目录存有各来源的 MCP 服务器配置，按下表还原到原路径（**文件不存在则跳过，不是错误**）：

| 仓库文件 | 还原目标 |
|---|---|
| `mcp/agent-mcp.json` | `PI_AGENT/mcp.json`（pi 全局 MCP 配置） |
| `mcp/pi-mcp.json` | `~/.pi/mcp.json` |
| `mcp/config-mcp.json` | `~/.config/mcp/mcp.json`（Windows: `%USERPROFILE%\.config\mcp\mcp.json`） |
| `mcp/agents-mcp.json` | `~/.agents/mcp.json` |
| `mcp/agents-mcp-mcp.json` | `~/.agents/mcp/mcp.json` |

```bash
# Linux 示例（其余文件同模式）
[ -f "$HOME/pi-config/mcp/agent-mcp.json" ] && cp "$HOME/pi-config/mcp/agent-mcp.json" "$HOME/.pi/agent/mcp.json"
```
```powershell
# Windows 示例
if (Test-Path "$env:USERPROFILE\pi-config\mcp\agent-mcp.json") {
  Copy-Item "$env:USERPROFILE\pi-config\mcp\agent-mcp.json" "$env:USERPROFILE\.pi\agent\mcp.json"
}
```

### ✅ 步骤 6 验证

- 仓库里有 `mcp/agent-mcp.json`（高德地图 amap 配置，key 为明文占位符 `PASTE_YOUR_AMAP_MCP_KEY`）：
  还原后确认 `PI_AGENT/mcp.json` 存在且为合法 JSON。
- 本机 `mcp.json` 已存在（含明文 key）→ **保留本机版本**，不要用仓库模板覆盖。
- 首次安装 → 把 URL 里的 `PASTE_YOUR_AMAP_MCP_KEY` 直接替换成真实高德 key（明文，见步骤 7）。
- 仓库里没有 `mcp/` 文件时：跳过并在报告中注明「当前无 MCP 服务器配置」。

---

## 7. API 密钥 — 明文直填（不再逐项输入）

**仓库里没有真 Key**：仓库的 `models.json` / `auth.json.example` / `mcp/agent-mcp.json` 中只有
`PASTE_YOUR_...` 占位符。**密钥策略是明文**：Key 直接写在本机配置文件里 —— 不用环境变量、
不写 `~/.pi/secrets/pi-secrets.env`、不需要 shell source。

| 文件 | 怎么写 | Key 来源 |
|---|---|---|
| `PI_AGENT/models.json` | provider 的 `apiKey` 字段直接写明文 `sk-...` | 用户自己的 Key |
| `PI_AGENT/auth.json` | `{"<provider>":{"type":"api_key","key":"sk-..."}}` | 用户自己的 Key |
| `PI_AGENT/mcp.json` | URL 里直接拼 key：`...?key=<高德key>` | 用户自己的 Key |

### 7.1 优先复用本机已有的明文配置（**不要覆盖**）

`models.json` / `models-store.json` / `auth.json` 是**不同步文件**：本机已有就保持原样
（步骤 3 备份、步骤 4 已还原；用还原脚本时自动处理）。仅当本机确实没有 `auth.json` 时才从模板生成：

```bash
[ -f "$HOME/.pi/agent/auth.json" ] || cp "$HOME/.pi/agent/auth.json.example" "$HOME/.pi/agent/auth.json"
chmod 600 "$HOME/.pi/agent/auth.json"
```

### 7.2 检查仍未填的占位符（需要用户参与 ⚠️）

```bash
grep -nE 'PASTE_YOUR_|sk-PASTE|[$][{]PI_|[{]env:' \
  "$HOME/.pi/agent/models.json" "$HOME/.pi/agent/auth.json" "$HOME/.pi/agent/mcp.json" 2>/dev/null
```

- **有命中** → 停下来提示用户：把命中的位置替换成真实 Key（明文），改完告知 AI 继续。
  **AI 不得猜测 Key，也不得把 Key 写进日志 / 报告 / 会话记录。**
- **无命中** → 本机 Key 已就绪，直接继续。

> 用户暂时没有某家 Key 也可以继续：保留该处占位符，报告里注明「该 provider 不可用」，
> 不要因此阻塞其他步骤。

### ✅ 步骤 7 验证

- `auth.json` 存在、权限 600；`models.json` / `mcp.json` / `auth.json` 均为合法 JSON。
- 三个文件中不再有 `PASTE_YOUR_` / `sk-PASTE` / `${PI_` / `{env:` 残留（用户明确暂不配置的除外）。
- **不要**引导用户创建 `~/.pi/secrets/`，也**不要**往 `.bashrc` / `.zshrc` 注入 source 代码。
- 模型配置以本机为准：不要用仓库 `models.json` 覆盖本机已有的（见步骤 4「不同步文件」）。

---

## 8. 还原 npm packages（需联网）

**方式 A（推荐）：交给 pi 自动安装** — 启动一次 pi，它会按 `settings.json` 的 packages 列表自动安装：

```bash
pi   # 运行后等待其自动安装完成，然后退出（或直接进入步骤 9 后由用户启动）
```

**方式 B（手动，可在启动前执行）**：

```bash
# Linux
cd "$HOME/.pi/agent/npm" && npm ci
```
```powershell
# Windows
Set-Location "$env:USERPROFILE\.pi\agent\npm"; npm ci
```

### ✅ 步骤 8 验证

- `npm/node_modules/` 存在且非空（`ls node_modules | wc -l` 输出大于 5；完全离线时可能为 0，注明即可）。
- `extensions/bash-guard/node_modules/shell-quote/` 存在（bash-guard 依赖；未安装时 bash-guard 扩展会报 shell-quote 找不到，可手动：`cd $PI_AGENT/extensions/bash-guard && npm install --omit=dev`）。
- `npm ci` 失败但 pi 能启动：接受降级，注明「由 pi 首次启动时自动安装」。

---

## 9. 最终验证与还原报告

### 9.1 逐项检查（全部通过才算成功）

```bash
# Linux
ls "$HOME/.pi/agent/settings.json" "$HOME/.pi/agent/models.json" "$HOME/.pi/agent/AGENTS.md" >/dev/null && echo "核心配置 OK"
find "$HOME/.pi/agent/skills" -maxdepth 1 -type d | wc -l   # 应 >= 13
ls "$HOME/.pi/agent/extensions/"                              # 8 个 ts 文件 + bash-guard/ + prompt-snippets/ + mcp/ 目录
cat "$HOME/.pi/agent/settings.json" | python3 -m json.tool >/dev/null && echo "settings.json 合法 JSON"
[ -f "$HOME/.pi/agent/auth.json" ] && echo "auth.json 存在" || echo "⚠ auth.json 缺失（可从 example 生成）"
grep -qE 'PASTE_YOUR_|sk-PASTE|[{]env:' "$HOME/.pi/agent/models.json" "$HOME/.pi/agent/auth.json" "$HOME/.pi/agent/mcp.json" 2>/dev/null && echo "⚠ 仍有未填占位符（需用户提供明文 Key）" || echo "密钥占位符已填好"
[ -f "$HOME/.pi/agent/mcp.json" ] && cat "$HOME/.pi/agent/mcp.json" | python3 -m json.tool >/dev/null && echo "mcp.json 存在且合法"
pi --version
```
```powershell
# Windows
Test-Path "$env:USERPROFILE\.pi\agent\settings.json"   # True
(Get-ChildItem "$env:USERPROFILE\.pi\agent\skills" -Directory).Count  # 应 >= 13
Get-Content "$env:USERPROFILE\.pi\agent\settings.json" -Raw | ConvertFrom-Json | Out-Null; Write-Host "settings.json 合法 JSON"
pi --version
```

### 9.2 输出还原报告（中文，逐条列出）

```
## 还原报告
- 平台：<Linux x86_64 / Windows ...>
- 配置来源：<git clone / ZIP 下载>
- 核心配置：✅ / ❌ <具体缺失项>
- extensions：✅ 8 ts + 2 目录（本次新增：live-thinking / question / bash-guard / prompt-snippets）
- skills：✅ N 个目录（当前 13，本次新增：analyze-sessions）
- MCP 配置：✅ amap 已还原（key: 本机明文已就绪 / 保留本机版本 / ⚠ 占位符未填）
- 密钥：✅ 本机明文已就绪 / ⚠ 有占位符待用户填（列出是哪几个 provider）
- 模型配置：✅ 保留本机版本（不同步，未被仓库覆盖）
- npm packages：✅ 已安装 N 个 / ⚠ 需 pi 首次启动自动安装
- 旧配置备份位置：<.bak-* 路径>
- 遗留问题：<列出所有未完成项及原因>
```

### 9.3 收尾

- 告知用户：现在启动 `pi` 即可，首次启动会自动完成 packages 安装与扩展加载。
- 可选清理：删除 `PI_SRC` 克隆目录前先询问用户（建议保留以便日后更新）。

---

## 附录 A：常见异常处理

| 症状 | 处理 |
|---|---|
| git clone 失败（网络/代理） | 重试 2 次 → 改用方式 B 下载 ZIP → 仍失败则停止并报告 |
| 还原后 `pi` 命令不存在 | 提示用户 `npm install -g @earendil-works/pi-coding-agent`（Windows 需 Node.js ≥ 20） |
| `npm ci` 报错 ENOENT/网络 | 跳过，交 pi 首次启动自动安装 |
| settings.json 里包无法安装（版本冲突） | 不阻塞，报告具体包名 |
| 用户机器是 Linux ARM（如树莓派） | bin/ 已删除，提示 pi 会获取对应架构的 fd/rg |
| 还原后扩展报错 | 检查 `extensions/` 文件是否完整 → 报告错误信息，不擅自改代码 |
| 还原后 pi 报 ENOENT（`no such file or directory ... sessions/...jsonl`） | 原因：备份时把运行中的 pi 正在写入的 `sessions/` 目录 mv 走了，pi 按原路径追加会话日志失败。**旧会话文件并没有丢**，在 `.bak-*/sessions/` 里。处理：`mkdir -p ~/.pi/agent && mv ~/.pi/agent.bak-*/sessions ~/.pi/agent/`（把会话目录移回原位即可，无需重跑还原）。备份逻辑已更新为保留 sessions/ 在原位，新还原不会再出现此问题。 |
| 用户无任何密钥 | 明确告知：pi 可启动，但对应 provider 无法调用；按步骤 7.2 引导用户把**明文** Key 直接填进 `models.json` / `auth.json` / `mcp.json`（不要再用环境变量那套） |
| 配置里还有 `PASTE_YOUR_...` / `${PI_...}` 占位符 | 明文策略下需替换成真实 Key；用户暂时没有就先跳过，并在报告中注明对应模型不可用 |
| 想确认模型配置没被同步冲掉 | `git -C ~/pi-config log --oneline -1` 与实际 `~/.pi/agent/models.json` 对比即可；不同步文件本地说了算 |

## 附录 B：更新已有还原（原机器配置变更后）

1. 原机器重新打包：`~/pi-backup/make-backup.sh`（本地完整备份，含密钥）。
2. 更新仓库：`git add -A && git commit -m "update" && git push`（仓库不含 auth.json / sessions，也不含任何真 Key）。
   > **同步范围规则**：只推插件 / Skill / MCP / 脚本；模型与鉴权相关文件不要改、不要推，各机器自己保留。
3. 新机器重新执行本清单（步骤 3 会自动备份旧配置）。
