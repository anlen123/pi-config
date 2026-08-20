# pi-config

[pi](https://github.com/badlogic/pi-mono/) 编码助手的便携配置备份仓库。
包含全局设置、插件（extensions）、Skills、MCP 配置，可在新电脑上快速还原环境。

## 内容结构

```
├── agent/                  # = ~/.pi/agent 核心目录
│   ├── settings.json       # 全局设置（主题、默认模型、packages 列表）
│   ├── models.json         # 自定义 provider / model 配置
│   ├── models-store.json
│   ├── AGENTS.md           # 全局沟通规则
│   ├── extensions/         # 本地插件（model-info-footer、context-progress-bar、MCP 客户端）
│   ├── skills/             # 全部 Skills（含自定义技能）
│   ├── npm/                # npm 包清单（还原时联网重装 node_modules）
│   ├── git/                # git 方式安装的包（pi-ocr-tool）
│   ├── fff/                # 文件访问频率索引
│   └── bin/                # fd/rg 二进制（Linux-x86_64，其他平台还原时自动清理）
├── mcp/                    # MCP 服务器配置（按原路径还原）
├── restore.sh              # Linux/macOS 还原脚本
├── restore.ps1             # Windows 还原脚本
└── INFO.txt                # 备份信息
```

## 还原步骤（新电脑）

```bash
# 1. 安装 pi
npm install -g @earendil-works/pi-coding-agent

# 2. 克隆本仓库
git clone git@github.com:anlen123/pi-config.git
cd pi-config

# 3. 还原（Linux/macOS）
bash restore.sh
# Windows: powershell -ExecutionPolicy Bypass -File .\restore.ps1

# 4. 启动（首次启动自动安装 settings.json 中声明的 packages）
pi
```

还原脚本会自动备份旧配置到 `~/.pi/agent.bak-<时间戳>`，并清理平台不兼容的二进制。

## ⚠️ 重要说明

### auth.json（API 密钥）不在此仓库中

出于安全考虑（本仓库是 **public**），`agent/auth.json`（含 deepseek / sensenova
API 密钥）**未上传**。还原后需要手动补上，二选一：

- **方式 A**：从原电脑 `~/.pi/agent/auth.json` 复制到新电脑相同位置
- **方式 B**：直接编辑新电脑的 `~/.pi/agent/auth.json`，格式参考
  `agent/auth.json.example`（本仓库提供模板）

### 会话历史（sessions/）不在仓库中

对话历史含隐私内容，未上传。完整离线备份请使用本地 ZIP
（见下方「本地完整备份」），新电脑上还原后再把 sessions/ 拷入即可。

### 更新备份

原电脑上修改配置后，重新打包并推送：

```bash
# 在 ~/pi-backup/ 下重新生成 ZIP
./make-backup.sh

# 更新本仓库（注意：默认不含 auth.json 和 sessions/）
git add -A && git commit -m "update backup" && git push
```

## 本地完整备份（含密钥）

完整备份（含 auth.json、sessions/）请使用本地工具：

```bash
~/pi-backup/make-backup.sh            # 默认备份
~/pi-backup/make-backup.sh --include-node-modules   # 含离线依赖
```

产物为 `~/pi-backup/pi-portable-<时间戳>.zip`，请妥善保管（含明文密钥）。
