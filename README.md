# pi-config

个人 Pi 配置仓库，包含配置、扩展、提示片段和技能，而不只包含某个插件。

## 内容

- `agent/settings.json`：默认模型、主题、推理级别及扩展包配置。
- `agent/models.json`：模型与服务商配置；API Key 使用占位符，不提交真实密钥。
- `agent/mcp.json`：MCP 服务配置；公开版本的认证头已脱敏。
- `agent/AGENTS.md`、`agent/keybindings.json`：全局规则和快捷键。
- `agent/extensions/`：自定义扩展及提示片段，包括 Codex 周额度/Token 状态栏和完整对话耗时显示。
- `agent/skills/`：技能与配套脚本，包括 Android 逆向分析等。
- 其它已跟踪的插件设置、模型目录缓存及 MCP 元数据随配置同步。

## 使用

安装 Pi 后，将需要的 `agent/` 配置部署到 `~/.pi/agent/`；扩展包按 `settings.json` 安装。不要覆盖本机的登录文件。配置更新后在 Pi 中执行 `/reload`。

### 两个状态栏插件

- [`codex-status`](agent/extensions/codex-status/README.md)：周剩余额度、累计 Token，以及最近完整对话消耗的括号值。
- [`dialogue-timer`](agent/extensions/dialogue-timer/README.md)：每次完整运行结束后显示 `本次耗时 1:05`。

## 敏感信息

- `auth.json`、会话、机器信任信息等继续遵循 `.gitignore`，不作为公开配置上传。
- API Key 与 MCP 认证占位符需要在本机自行配置，不能直接使用占位符连接服务。
- 当前机器的真实 `agent/mcp.json` 工作文件保留不变；提交给 Git 的公开副本使用脱敏认证头，因此本机可能显示该文件有未提交的私有覆盖。后续同步前仍需对公开副本脱敏，不能直接把真实认证头推送。
- 本次同步不改写 Git 历史；曾经公开过的凭据应轮换。仅从最新版本删除敏感值不能使旧凭据重新安全。

## 测试

```bash
cd agent/extensions/codex-status && npm test
cd ../dialogue-timer && npm test
```

插件测试不消耗真实模型 Token，详细说明见各插件 README。
