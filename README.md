# pi-config

[pi](https://github.com/badlogic/pi-mono/) 编码助手的便携配置备份仓库。
包含全局设置、插件（extensions）、Skills、MCP 配置，可在新电脑上快速还原环境。

## 🔄 还原方式与选项

```bash
bash restore.sh                       # 交互合并（默认）：先给差异汇总，再选处理方式
bash restore.sh --status              # 只做三方对比报告，不写入任何文件
bash restore.sh --dry-run             # 预览将要发生的变更，不写入
bash restore.sh --yes                 # 非交互：按智能推荐处理（自动化 / CI）
bash restore.sh --take-repo           # 非交互：全部采用仓库版本（模型/鉴权仍跳过）
bash restore.sh --keep-local          # 非交互：全部保留本地，只补缺失文件
bash restore.sh --only ext,skills,mcp # 只同步指定类别（ext/skills/mcp/npm/misc）
bash restore.sh --fresh               # 全新覆盖：备份旧配置后整体替换（模型/鉴权文件仍保留本机）
```

Windows 同款参数：`powershell -ExecutionPolicy Bypass -File .\restore.ps1 -Status / -DryRun / -Yes / -TakeRepo / -KeepLocal -Only ext,skills`

### 合并逻辑：三方对比（`restore-engine.py`）

同步过一次后，仓库快照会记在 `~/.pi/agent/.pi-config-sync.json`，
下次同步就能区分「谁改的」，默认动作更聪明：

| 情况 | 判定 | 智能推荐动作 |
|---|---|---|
| 仓库改了、本地没动 | 仅仓库改 | ✅ 直接采用仓库版本 |
| 本地改了、仓库没动 | 仅本地改 | ⏸ 保留本地 |
| 两边都改了 | **冲突** | ⏸ 保留本地（逐文件模式可选 C 逐块融合） |
| 本地没有该文件 | 新增 | ✅ 安装仓库版本 |

交互模式**先给出按类别统计的差异汇总**（新增 / 仅仓库改 / 冲突 / 仅本地改），
再一次性选处理方式，不用对着几百个文件逐个按键：

```
  处理方式：
    [1] 智能推荐（新增/仅仓库改→用仓库；冲突/仅本地改→保留本地）  ← 默认
    [2] 全部采用仓库版本（模型/鉴权文件仍跳过）
    [3] 全部保留本地（只补齐缺失文件）
    [4] 逐文件选择（A/B/C，可 d 看 diff）
    [5] 只报告不写入
```

逐文件模式下每个文件可选：

| 选项 | 行为 |
|---|---|
| **A** | 采用仓库版本（本地旧版本自动备份到 `~/.pi/agent.merge-bak-<时间戳>/`） |
| **B** | 保留本地不动 |
| **C** | **逐块融合**：逐个差异块列出「本地 vs 仓库」，选 1=保留本地 / 2=采用仓库 / 3=两者都要 |
| **d** | 直接打印该文件的 unified diff |
| **a / l** | 剩余文件全部采用仓库 / 全部保留本地 |
| **q** | 中止（已处理的文件不回滚，备份目录仍在） |

### 其它行为

- 本地有、仓库没有的文件**一律保留**，绝不删除
- 模型 / 鉴权文件和 `settings.json` 的默认模型字段**永不参与覆盖**（见下节）
- 没有 `python3` 时自动降级为「只补齐缺失文件」（装 `python3` 才有三方对比 / 融合）

### 全新覆盖模式（`--fresh`）

把现有 `~/.pi/agent` 整体备份到 `~/.pi/agent.bak-<时间戳>` 后用仓库版本替换，
但 `models.json` / `models-store.json` / `auth.json` 会从备份还原回本机版本，
`settings.json` 的默认模型字段也保持本机值（`sessions/` 始终保留在原位）。

## 🚫 同步范围：模型相关的一律不动

还原（`restore.sh` / `restore.ps1`）**只会覆盖**这些内容：

- `extensions/`（插件源码）、`skills/`（技能）、`mcp/`（MCP 配置）、`extensions-disabled/`
- `npm/package.json`（插件包清单）、`restore.sh` / `restore.ps1`、`AI-RESTORE.md` 等脚本
- `settings.json` 的**非模型字段**（主题、TUI 模式、packages 列表、快捷键等）

**永远不同步**，本地已有就保持原样（`--fresh` 也会从备份还原回来）：

| 文件 / 字段 | 为什么 |
|---|---|
| `agent/models.json` | 各机器的 provider / model 定义不同 |
| `agent/models-store.json` | 模型列表状态，属本机运行时数据 |
| `agent/auth.json` | 明文密钥 |
| `agent/fff/**/*.mdb` | frecency/history 运行时数据库与锁文件 |
| `settings.json` 的 `defaultProvider` / `defaultModel` / `defaultThinkingLevel` | 默认模型由本机说了算 |

> 一句话：**拉取仓库更新不会动你的模型配置**。模型怎么配、用哪个模型，永远由本机决定。

MCP 配置（`mcp/`）在同步范围内，但引擎比较时会**忽略 key 值**：本机填了真实 key、仓库里是
`PASTE_YOUR_...` 占位符，两者视为一致；万一仓库模板结构有更新（新增服务器等），采用仓库版时
也会**自动把本机 key 填回去**。

## 🔑 密钥：明文直填，不用环境变量

策略就一句话：**能用明文就用明文**。Key 直接（明文）写进本机配置文件，不做环境变量中转、不写 `~/.pi/secrets`、还原时也不再询问：

| 文件 | 怎么写 |
|---|---|
| `~/.pi/agent/models.json` | provider 的 `apiKey` 字段直接写 `sk-...` |
| `~/.pi/agent/auth.json` | 按 provider 明文写：`{"deepseek":{"type":"api_key","key":"sk-..."}}` |
| `~/.pi/agent/mcp.json` | URL 里直接拼 key：`...?key=你的高德key` |

- 本仓库（public）里这些位置**只有占位符** `sk-PASTE_YOUR_SUIXIANG_KEY` / `PASTE_YOUR_AMAP_MCP_KEY`，真 Key 一律不入库
- 换机器时把 Key 粘贴进上面三个文件即可，**不用重启 shell、不用 source**
- 若你以前用过 `pi-secrets.env` 那套：删掉 `~/.pi/secrets/`，并把 `~/.bashrc` / `~/.zshrc` 里那段自动 source 删掉即可（现在完全不需要）
- 想换 Key：直接改这三个文件里的明文值，重启 pi 生效；旧 Key 到供应商后台吊销

## 🚀 AI 自动还原

在新机器上安装好 pi 后，启动 pi 并对它说：

```
请阅读 https://raw.githubusercontent.com/anlen123/pi-config/main/AI-RESTORE.md
并严格按照其中的步骤清单，帮我还原我的 pi 编码助手环境。
```

pi（或任意带终端工具的 AI）会按 [AI-RESTORE.md](AI-RESTORE.md) 自动完成：
平台检测（Windows/Linux）→ 获取配置 → 备份旧配置 → 还原 → 平台适配 → MCP → 密钥确认 → 验证报告。

## 内容结构

```
├── agent/                     # = ~/.pi/agent 核心目录
│   ├── settings.json          # 全局设置（主题、默认模型、packages 列表）
│   ├── models.json            # 自定义 provider/model（apiKey 明文；同步时不动）
│   ├── AGENTS.md              # 全局沟通规则
│   ├── keybindings.json       # 自定义快捷键
│   ├── auth.json.example      # auth.json 明文模板（PASTE_YOUR_... 占位符）
│   ├── trust.json             # 项目信任列表
│   ├── pi-fff.json            # fff 设置
│   ├── extensions/            # 本地插件（bash-guard、check-model、context-progress-bar、
│   │                          #   deepseek-balance、deepseek-peak-status、herdr-agent-state、
│   │                          #   live-thinking、live-tool-output、win-notify、
│   │                          #   prompt-snippets、question）
│   ├── extensions-disabled/   # 已归档插件（model-info-footer、dedupe-status、
│   │                          #   旧版 mcp 客户端；pi 不加载，含恢复说明）
│   ├── skills/                # 全部 Skills
│   ├── npm/                   # npm 包清单（还原时联网重装 node_modules）
│   ├── git/                   # git 方式安装的包（pi-ocr-tool）
│   ├── fff/                   # 文件访问频率索引
│   └── bin/                   # fd/rg 二进制（Linux-x86_64，其他平台还原时自动清理）
├── mcp/
│   └── agent-mcp.json         # → ~/.pi/agent/mcp.json（高德地图，key 明文占位）
├── AI-RESTORE.md              # ⭐ AI 执行清单（还原时优先让 AI 读这个）
├── restore-engine.py          # 合并引擎（三方对比 / 批量决策 / 逐块融合，跨平台）
├── restore.sh                 # Linux/macOS 入口（转发给引擎；--fresh 自带实现）
├── restore.ps1                # Windows 入口（有 Python 时同样转发给引擎）
└── INFO.txt                   # 备份信息
```

## 还原步骤（新电脑）

```bash
# 1. 安装 pi
npm install -g @earendil-works/pi-coding-agent

# 2. 克隆本仓库
git clone git@github.com:anlen123/pi-config.git
cd pi-config

# 3. 还原（Linux/macOS）
bash restore.sh --status   # 先看差异报告（可选，不写入）
bash restore.sh            # 交互合并（先汇总差异，再选处理方式）
# bash restore.sh --yes    # 非交互：按智能推荐合并
# bash restore.sh --fresh  # 或全新覆盖（模型/鉴权文件仍保留本机）
# Windows: powershell -ExecutionPolicy Bypass -File .\restore.ps1 -Status

# 4. 把各供应商 Key 明文填进 ~/.pi/agent/models.json / auth.json / mcp.json
#    （仓库模板里是 PASTE_YOUR_... 占位符；脚本结束时也会提示哪些还没填）

# 5. 启动（首次启动自动安装 settings.json 中声明的 packages）
pi
```

还原脚本会自动联网安装 bash-guard 依赖（shell-quote）和 npm 包清单依赖。

## 📝 更新日志

### 2026-09-12

- 同步本机 `live-tool-output.ts`，并将 `settings.json` 的 `tuiMode` 更新为 `fullscreen`；默认模型字段保持仓库原值。
- 新增 `extensions/pi-tool-display/config.json` 与 `obscura-mcp-autostart.ts`。
- MCP 模板新增 `local-mcp`（`http://127.0.0.1:8080/mcp`），高德 Key 仍保留占位符。
- Obscura 自动启动插件依赖本机另行安装的 `/opt/obscura/obscura` 或用户级 `obscura-mcp` systemd 服务；仓库不包含该二进制或服务配置。换机时需先安装依赖，或禁用此扩展及 `local-mcp`。默认日志路径 `/var/log/obscura-mcp.log` 也需要写权限。

### 2026-09-11

- **密钥改为明文直填**：彻底移除 `~/.pi/secrets/pi-secrets.env` 与环境变量引用那一套 —— `models.json` / `auth.json` / `mcp.json` 现在直接写明文 Key，还原脚本不再逐项询问密钥、不再往 `.bashrc` / `.zshrc` 注入 source
- **新增同步范围规则**：还原只同步插件 / Skill / MCP / 脚本，`models.json`、`models-store.json`、`auth.json` 以及 `settings.json` 的默认模型字段**一律不同步**（`--fresh` 也会从备份还原回来），避免拉取更新时冲掉本机模型配置
- `auth.json.example`、`mcp/agent-mcp.json` 改为明文样式模板（`PASTE_YOUR_...` 占位符），仓库中依旧无任何真 Key
- `restore.sh` / `restore.ps1` 结束时改为检查并列出仍未填的占位符
- **还原逻辑重写（`restore-engine.py`）**：改为**三方对比**（上次同步仓库快照 / 本地 / 仓库当前），
  区分「仅仓库改 / 仅本地改 / 冲突 / 新增」；交互模式先给差异汇总再选处理方式（智能推荐 / 全用仓库 /
  全保留本地 / 逐文件 / 只报告）；新增 `--status`、`--dry-run`、`--yes`、`--take-repo`、
  `--keep-local`、`--only <类别>` 参数与同步基准 `.pi-config-sync.json`；逐文件模式支持 `d` 看 diff、
  `a/l` 批量决定、`q` 中止；`--fresh` 结束后也会写入基准

### 2026-09-11（第二批）

- 同步本机较新的插件与依赖：`live-thinking.ts`（改用 `thinkingVisibilityOverrides` 的新版逻辑）、
  新增 `live-tool-output.ts`（命令输出执行中展开/结束折叠）、`win-notify.ts`（WSL 下 Windows Toast 通知）；
  `npm/package.json` + `package-lock.json` 升级（pi-mcp-adapter 2.33.0、pi-subagents 0.67.0、
  pi-web-access 0.29.0、pi-powerline-footer 0.17.1）；`prompt-snippets` 的 import 统一为 `@earendil-works/*`
- 合并引擎增强：MCP 配置比较**忽略 key 值**（本机真实 key vs 仓库占位符不再被当成差异）；
  采用仓库版 MCP 模板时**自动保留本机 key**；仓库里未 `git add` 的文件会提示"不参与同步"
- `.gitignore`：`win-notify.json` / `live-tool-output.json` 归入本地运行时状态
- `agent/fff/**/*.mdb`（frecency / history 运行时库与锁文件）纳入"不同步"：不再作为二进制差异反复提示，
  也不会被仓库版本覆盖；新增 `--status --list` 可逐条列出差异文件

### 2026-09-10

- **restore.sh 重写**：新增交互合并模式（本地 vs 远程逐文件对比，A=远程为主 / B=本地为主 / C=融合逐块挑选冲突）；密钥改为手动输入并写入 `~/.pi/secrets/pi-secrets.env`（600 权限）；`--fresh` 保留旧覆盖行为；加入短输入误操作防护
- **密钥机制升级**：`models.json`（suixiang/agentrouter/modelflare）、`auth.json`（deepseek/fluxionai）、`mcp.json`（高德）全部改为 `$PI_*_API_KEY` / `${PI_AMAP_MCP_KEY}` 环境变量引用，仓库与本地配置均无明文密钥
- **prompt-snippets 增强**：
  - 新增 `continue-task.md` 片段（继续被中断的任务：先恢复上下文、核对进度，再从中断处继续）
  - 修改插件支持**空输入回车直接发送**：有激活片段且输入框为空时，直接 Enter 发送合并后的片段内容（编辑器为空时宿主会忽略提交，因此插件对编辑器做了挂钩，与 powerline 的自定义编辑器兼容）
- **插件归档**：`model-info-footer`（与 pi-powerline-footer 重复）、`dedupe-status`（desktop-ui 已卸载）、旧版本地 `mcp` 客户端（由 pi-mcp-adapter 接管）移入 `extensions-disabled/`，pi 不再加载
- **llm-wiki**：移除 `youtube-transcript` 外挂依赖，YouTube 来源改为手动粘贴模式（相关引用同步更新 5 个文件）
- 默认模型切换为 `modelflare/glm-5.3-flash`；`@narumitw/pi-btw` 升级至 0.58.1

### 更早

见 `git log`。

## ⚠️ 重要说明

### 本仓库不含任何真 Key（public 仓库）

- `agent/auth.json` 被 `.gitignore` 排除；仓库只提供 `auth.json.example` 明文模板
- `models.json` / `mcp/agent-mcp.json` 里的 Key 位置全是 `PASTE_YOUR_...` 占位符
- 真 Key 只在各机器本地：`~/.pi/agent/models.json`、`auth.json`、`mcp.json`（明文，600 权限）
- 用 `/login` 重新登录某供应商时，pi 会把新 Key 明文写回 `auth.json`，属正常行为

### 模型配置不会被仓库覆盖

- 同步范围见上文「🚫 同步范围」；`models.json` / `models-store.json` / `auth.json` 与
  `settings.json` 的默认模型字段永不参与覆盖，本地已有就一定是本地说了算
- 因此可以放心 `git pull` 拿插件 / Skill / MCP 更新，不用担心模型配置被改回去

### 同步基准与回滚

- `~/.pi/agent/.pi-config-sync.json` 记录上次同步时的仓库 commit 与各文件哈希（本地文件，不入库）；
  删掉它只会让下次同步退化为「无基准」模式（差异默认保留本地），不会破坏任何配置
- 每次合并前被覆盖的本地文件都备份在 `~/.pi/agent.merge-bak-<时间戳>/`，需要回滚直接拷回即可
- `--fresh` 的整体备份在 `~/.pi/agent.bak-<时间戳>/`
