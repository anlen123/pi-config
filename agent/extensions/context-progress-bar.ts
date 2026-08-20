/**
 * Context Progress Bar - 用进度条显示上下文窗口使用率，不显示数字
 *
 * 在 footer 的状态栏中渲染一个块字符进度条：
 *   ctx ██████▌░░░
 *
 * - 填充部分按使用率着色：≤70% 绿色(success)，70-90% 黄色(warning)，>90% 红色(error)
 * - 剩余部分用暗色 ░ 表示
 * - 使用 8 分位块字符（▏▎▍▌▋▊▉█），8 个字符宽，共 64 档精度
 * - 压缩后 token 未知时（percent === null）显示全暗空条
 *
 * 依赖：pi-powerline-footer 的 extension_statuses 段（默认 preset 已包含）。
 * 请在 settings.json 中禁用 powerline 的 context_pct / context_total 段以避免重复显示数字。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CELLS = 8; // 进度条字符宽度
const SUB = 8; // 每个字符 8 档（▏▎▍▌▋▊▉█）
const TOTAL = CELLS * SUB; // 总档数 64

const PARTIAL: string[] = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

export default function (pi: ExtensionAPI) {
	function renderProgress(ctx: any) {
		const theme = ctx.ui?.theme;
		if (!theme) return;

		const usage = ctx.getContextUsage?.();
		const percent = usage?.percent ?? null;
		const dim = (s: string) => theme.fg("dim", s);

		if (percent === null || percent === undefined) {
			// 未知（例如刚压缩后、首个响应前）
			ctx.ui.setStatus("context-progress", dim("ctx ") + dim("░".repeat(CELLS)));
			return;
		}

		const filledSub = Math.round((Math.min(100, Math.max(0, percent)) / 100) * TOTAL);
		const fullChars = Math.floor(filledSub / SUB);
		const partial = filledSub % SUB;

		const color = percent > 90 ? "error" : percent > 70 ? "warning" : "success";
		const fill = theme.fg(color, "█".repeat(fullChars) + PARTIAL[partial]);
		const empty = dim("░".repeat(Math.max(0, CELLS - fullChars - (partial > 0 ? 1 : 0))));

		ctx.ui.setStatus("context-progress", dim("ctx ") + fill + empty);
	}

	pi.on("session_start", (_event, ctx) => renderProgress(ctx));

	for (const event of [
		"turn_end",
		"agent_end",
		"agent_settled",
		"session_compact",
		"session_info_changed",
	] as const) {
		pi.on(event as never, (_event: never, ctx: any) => renderProgress(ctx));
	}
}
