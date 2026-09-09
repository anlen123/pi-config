# pi-config

[pi](https://github.com/badlogic/pi-mono/) 编码助手的便携配置备份仓库。
包含全局设置、插件（extensions）、Skills、MCP 配置，可在新电脑上快速还原环境。

## 🔄 两种还原模式

```bash
bash restore.sh            # 交互合并模式（默认）
bash restore.sh --fresh    # 全新覆盖模式
```

### 交互合并模式（默认）

逐文件对比 **本地 `~/.pi/agent`** 与 **本仓库**，只处理有差异的文件：

| 选项 | 行为 |
|---|---|
| **A** | 以**远程（仓库）为主**：覆盖本地（本地旧版自动备份到 `~/.pi/agent.merge-bak-<时间戳>/`） |
| **B** | 以**本地为主**：保留本地不动 |
| **C** | **两者融合**：逐个差异块列出 `本地 vs 仓库` 内容，由你逐块挑选（1=保留本地 / 2=采用仓库 / 3=两者都要）；也可对单文件剩余冲突一键 `s=全用本地` 或 `a=全用仓库` |

- 本地有、仓库没有的文件**一律保留**，绝不删除
- 仅仓库有的文件会询问是否安装
- 二进制文件（如 fff 索引）只支持 A/B
- 非交互终端（如 CI 管道）自动降级为"仅安装缺失文件，差异保留本地"

### 全新覆盖模式（`--fresh`）

旧行为：把现有 `~/.pi/agent` 整体备份到 `~/.pi/agent.bak-<时间戳>` 后用仓库版本替换
（`sessions/` 始终保留在原位，避免运行中的 pi 写会话报 ENOENT）。

## 🔑 模型供应商密钥：手动输入，绝不入库

两种模式的还原脚本最后都会**逐项询问密钥**（本地输入、不回显），写入：

```
~/.pi/secrets/pi-secrets.env   # 目录 700 / 文件 600，被 shell 启动时自动 source
```

| 变量 | 用途 | 被引用于 |
|---|---|---|
| `PI_SUIXIANG_API_KEY` | suixiang（sui-xiang.com） | `models.json` |
| `PI_AGENTROUTER_API_KEY` | agentrouter（agentrouter.org） | `models.json` |
| `PI_MODELFLARE_API_KEY` | modelflare（modelflare.dev） | `models.json` |
| `PI_DEEPSEEK_API_KEY` | deepseek 官方 API | `auth.json` |
| `PI_FLUXIONAI_API_KEY` | fluxionai | `auth.json` |
| `PI_AMAP_MCP_KEY` | 高德地图 MCP | `mcp.json` |

- 配置文件里只保存 `$PI_*_API_KEY` / `${PI_AMAP_MCP_KEY}` **环境变量引用**（pi 原生支持，缺失时对应模型不可用），仓库中无任何明文密钥
- 已配置的密钥回车即跳过；输入新值则覆盖（<16 字符的疑似误输入需二次确认）
- **轮换密钥**：编辑 `pi-secrets.env` 对应行 → 重启 shell/pi；旧 Key 请到对应供应商后台吊销

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
│   ├── models.json            # 自定义 provider/model（密钥为 $PI_*_API_KEY 引用）
│   ├── AGENTS.md              # 全局沟通规则
│   ├── keybindings.json       # 自定义快捷键
│   ├── auth.json.example      # auth.json 模板（$PI_*_API_KEY 引用）
│   ├── trust.json             # 项目信任列表
│   ├── pi-fff.json            # fff 设置
│   ├── extensions/            # 本地插件（bash-guard、context-progress-bar、
│   │                          #   deepseek-balance、deepseek-peak-status、
│   │                          #   herdr-agent-state、live-thinking、
│   │                          #   prompt-snippets、check-model、question）
│   ├── extensions-disabled/   # 已归档插件（model-info-footer、dedupe-status、
│   │                          #   旧版 mcp 客户端；pi 不加载，含恢复说明）
│   ├── skills/                # 全部 Skills
│   ├── npm/                   # npm 包清单（还原时联网重装 node_modules）
│   ├── git/                   # git 方式安装的包（pi-ocr-tool）
│   ├── fff/                   # 文件访问频率索引
│   └── bin/                   # fd/rg 二进制（Linux-x86_64，其他平台还原时自动清理）
├── mcp/
│   └── agent-mcp.json         # → ~/.pi/agent/mcp.json（高德地图，${PI_AMAP_MCP_KEY} 引用）
├── AI-RESTORE.md              # ⭐ AI 执行清单（还原时优先让 AI 读这个）
├── restore.sh                 # Linux/macOS 还原脚本（交互合并 / --fresh）
├── restore.ps1                # Windows 还原脚本
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
bash restore.sh            # 交互合并（对比本地与仓库，A/B/C 选择）
# bash restore.sh --fresh  # 或全新覆盖
# Windows: powershell -ExecutionPolicy Bypass -File .\restore.ps1

# 4. 按脚本提示输入各供应商密钥（或之后编辑 ~/.pi/secrets/pi-secrets.env）

# 5. 启动（首次启动自动安装 settings.json 中声明的 packages）
pi
```

还原脚本会自动联网安装 bash-guard 依赖（shell-quote）和 npm 包清单依赖。

## 📝 更新日志

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

### 本仓库不含任何密钥（public 仓库）

- `agent/auth.json` 被 `.gitignore` 排除；仓库提供 `auth.json.example` 模板（`$PI_*_API_KEY` 引用）
- `models.json` / `mcp.json` 中只有环境变量引用，无明文
- 密钥唯一存放点：各机器本地的 `~/.pi/secrets/pi-secrets.env`（600 权限，不入库）
- 若用 `/login` 重新登录某供应商，pi 会把新 Key 写回 `auth.json`（本地 600 文件，属正常行为）
