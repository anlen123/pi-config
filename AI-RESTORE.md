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
3. **需要用户输入时停下询问**（见步骤 7 的 API 密钥），其余步骤自主完成。
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

如果目标目录已存在且非空，先备份（**不删除原数据**）：

```bash
# Linux
if [ -d "$HOME/.pi/agent" ] && [ -n "$(ls -A "$HOME/.pi/agent" 2>/dev/null)" ]; then
  mv "$HOME/.pi/agent" "$HOME/.pi/agent.bak-$(date +%Y%m%d-%H%M%S)"
  echo "已备份到: $HOME/.pi/agent.bak-*"
fi
```
```powershell
# Windows
if (Test-Path "$env:USERPROFILE\.pi\agent") {
  Move-Item "$env:USERPROFILE\.pi\agent" "$env:USERPROFILE\.pi\agent.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
}
```

### ✅ 步骤 3 验证

- 原目录已被改名（存在 `.bak-*` 目录），或原本就不存在。

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

### ✅ 步骤 4 验证（全部必须存在）

| 路径（相对 `PI_AGENT`） | 说明 |
|---|---|
| `settings.json` | 全局设置（含 12 个 packages） |
| `models.json` | 自定义 provider/model |
| `models-store.json` | 模型存储 |
| `AGENTS.md` | 全局沟通规则（中文） |
| `extensions/` | 至少 3 个文件（`model-info-footer.ts`、`context-progress-bar.ts`、`mcp/index.ts`） |
| `skills/` | 至少 26 个目录 |
| `npm/package.json` + `npm/package-lock.json` | 包清单 |
| `git/` | git 包缓存 |
| `auth.json.example` | 密钥模板（不是密钥本体） |

> **预期缺失**（正常现象，不要报错）：`auth.json`（密钥，步骤 7 处理）、`sessions/`（会话历史，不随仓库分发）。

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

- 仓库里有 `mcp/agent-mcp.json`（高德地图 amap 配置，key 为 `{env:AMAP_MCP_KEY}` 占位符）：
  还原后确认 `PI_AGENT/mcp.json` 存在且为合法 JSON。
- `mcp.json` 中的占位符 `{env:AMAP_MCP_KEY}` 无需手工替换：设置好环境变量后，pi 运行时自动展开（步骤 7 处理）。
- 仓库里没有 `mcp/` 文件时：跳过并在报告中注明「当前无 MCP 服务器配置」。

---

## 7. API 密钥（auth.json）— 需要用户参与 ⚠️

**密钥不在仓库中**（安全设计）。此步骤必须停下询问用户，二选一：

**选项 A：用户有原电脑的密钥文件**
让用户提供原 `~/.pi/agent/auth.json` 的路径（或把文件内容放到当前机器的临时位置），然后：

```bash
# Linux：用户提供路径 $KEY_SRC
cp "$KEY_SRC" "$HOME/.pi/agent/auth.json"
```
```powershell
# Windows
Copy-Item "$KEY_SRC" "$env:USERPROFILE\.pi\agent\auth.json"
```

**选项 B：用户手动填写（没有原文件时）**
告知用户：编辑 `$HOME/.pi/agent/auth.json`（Windows: `$env:USERPROFILE\.pi\agent\auth.json`），
格式参考仓库中的 `agent/auth.json.example`：
```json
{
  "deepseek": { "type": "api_key", "key": "sk-你的deepseek密钥" },
  "sensenova": { "type": "api_key", "key": "sk-你的sensenova密钥" }
}
```
**AI 不得代替用户猜测密钥**；用户填写完成后，AI 再验证。

### 7.2 高德 MCP key（`AMAP_MCP_KEY`）— 同样需要用户参与 ⚠️

`mcp/agent-mcp.json` 中的 URL 含占位符 `{env:AMAP_MCP_KEY}`（仓库 public，未存明文 key）。询问用户，二选一：

**选项 A：设置环境变量（推荐，免改文件）**

```bash
# Linux：写入 ~/.bashrc 或 ~/.zshrc 后 source
export AMAP_MCP_KEY="你的高德Web服务key"
```
```powershell
# Windows（PowerShell）
setx AMAP_MCP_KEY "你的高德Web服务key"
```
pi 运行时（pi-mcp-adapter）会自动把 `{env:AMAP_MCP_KEY}` 展开为环境变量值。**AI 不得把 key 输出到日志/报告**。

**选项 B：直接替换文件**（用户手动编辑，或用户提供 key 后由 AI 用安全方式写入）：

把 `PI_AGENT/mcp.json`（即还原后的 `mcp/agent-mcp.json`）中的 `{env:AMAP_MCP_KEY}` 替换为真实 key，得到：
```json
"url": "https://mcp.amap.com/mcp?key=你的真实key"
```

### ✅ 步骤 7 验证

- `auth.json` 存在且是合法 JSON，包含 `deepseek` 字段（或用户明确表示暂不配置密钥，此时在报告中注明，pi 仍可启动，只是默认 provider 不可用）。
- MCP：`AMAP_MCP_KEY` 已设置（`echo ${AMAP_MCP_KEY:+set}` 输出 `set`），或 `mcp.json` 中已无 `{env:AMAP_MCP_KEY}` 占位符。若用户暂不提供 key：保留占位符并在报告中注明（amap 工具不可用，其余功能正常）。

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
- `npm ci` 失败但 pi 能启动：接受降级，注明「由 pi 首次启动时自动安装」。

---

## 9. 最终验证与还原报告

### 9.1 逐项检查（全部通过才算成功）

```bash
# Linux
ls "$HOME/.pi/agent/settings.json" "$HOME/.pi/agent/models.json" "$HOME/.pi/agent/AGENTS.md" >/dev/null && echo "核心配置 OK"
find "$HOME/.pi/agent/skills" -maxdepth 1 -type d | wc -l   # 应 >= 26
ls "$HOME/.pi/agent/extensions/"                              # 3 个 ts 文件
cat "$HOME/.pi/agent/settings.json" | python3 -m json.tool >/dev/null && echo "settings.json 合法 JSON"
[ -f "$HOME/.pi/agent/auth.json" ] && echo "auth.json 存在" || echo "⚠ auth.json 缺失（用户未提供密钥）"
[ -f "$HOME/.pi/agent/mcp.json" ] && cat "$HOME/.pi/agent/mcp.json" | python3 -m json.tool >/dev/null && echo "mcp.json 存在且合法"
pi --version
```
```powershell
# Windows
Test-Path "$env:USERPROFILE\.pi\agent\settings.json"   # True
(Get-ChildItem "$env:USERPROFILE\.pi\agent\skills" -Directory).Count  # 应 >= 26
Get-Content "$env:USERPROFILE\.pi\agent\settings.json" -Raw | ConvertFrom-Json | Out-Null; Write-Host "settings.json 合法 JSON"
pi --version
```

### 9.2 输出还原报告（中文，逐条列出）

```
## 还原报告
- 平台：<Linux x86_64 / Windows ...>
- 配置来源：<git clone / ZIP 下载>
- 核心配置：✅ / ❌ <具体缺失项>
- extensions：✅ 3 个
- skills：✅ N 个目录
- MCP 配置：✅ amap 已还原（key: 环境变量 AMAP_MCP_KEY 已设置 / 已替换 / ⚠ 占位符未填）
- auth.json：✅ / ⚠ 未配置（用户需自行补密钥）
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
| 用户无任何密钥 | 明确告知：pi 可启动，但默认 provider（deepseek）无法调用，需用户补 auth.json |

## 附录 B：更新已有还原（原机器配置变更后）

1. 原机器重新打包：`~/pi-backup/make-backup.sh`（本地完整备份，含密钥）。
2. 更新仓库：`git add -A && git commit -m "update" && git push`（仓库不含 auth.json/sessions）。
3. 新机器重新执行本清单（步骤 3 会自动备份旧配置）。
