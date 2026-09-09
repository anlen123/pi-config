# 已归档扩展（不被 pi 加载）

此目录在 `extensions/` 之外，pi 不会加载这里的任何文件。归档时间：配置清理任务。

| 文件 | 归档原因 | 恢复方法 |
|---|---|---|
| `model-info-footer.ts` | 与 `pi-powerline-footer` 功能重叠（模型/Token/费用/思考级别），两者都调用 `setFooter`，后加载者覆盖前者，仅保留 powerline | `mv model-info-footer.ts ../extensions/` |
| `dedupe-status.ts` | 用于消除 `@hhyy668/pi-desktop-ui` 与 powerline 的重复 footer/widget，但 desktop-ui 已不在已装包列表中；其空 footer 覆盖逻辑反而可能干扰 powerline | 确认重新安装 desktop-ui 后再移回 |
| `mcp/` | 旧版本地 MCP 客户端，`MCP_SERVERS` 为空，实际 MCP 链路由 `pi-mcp-adapter` 包 + `~/.pi/agent/mcp.json` 负责 | 不建议恢复；如需可 `mv mcp ../extensions/` |

如需长期删除，直接 `rm -rf` 本目录即可。
