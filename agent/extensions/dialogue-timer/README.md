# 完整对话耗时

独立全局 Pi 插件：`~/.pi/agent/extensions/dialogue-timer/index.ts`。在 Pi 执行 `/reload` 后启用。

每次完整对话结束后，在状态栏的插件状态行显示：

```text
本次耗时 1:05
```

- 格式为 `m:ss`：分钟不补零，秒补两位；例如 `0:09`、`1:05`、`65:03`。
- 从首次 `agent_start` 到最终 `agent_settled`，包含该次运行中的模型响应、工具调用、等待、自动重试和自动续跑，不在低层 `agent_end` 提前结束或重新计时。
- 使用单调时钟 `performance.now()`；系统时间校准不影响耗时。按完整秒向下取整。
- 对话中止时也显示已经花费的时间。下一次运行中保留上一轮结果，完成后替换。无会话输入时不凭空显示 `0:00`。
- 不包含用户输入时间、运行前的准备阶段，以及对话完成后的后台额度刷新。
- 适用于所有模型，仅在交互终端中显示；不修改聊天记录，不弹出通知，不发网络请求，也没有定时轮询。
- 使用独立的 `ctx.ui.setStatus()` 键，兼容现有 `codex-status` 状态栏，不覆盖模型/额度/Token 信息。
- 新建/切换会话、退出或 `/reload` 时清除上次结果，从下一次完整运行重新计时。

## 测试

```bash
cd ~/.pi/agent/extensions/dialogue-timer
npm test
```

使用模拟时钟和网络，不消耗模型 Token。测试通过 `npm root -g` 定位 Pi；可用 `PI_PACKAGE_DIR` 指定包目录。`tsconfig.json` 中的类型路径对应本机 Pi 安装，运行时依赖由 Pi 提供。

卸载：移走 `~/.pi/agent/extensions/dialogue-timer/`，执行 `/reload`。
