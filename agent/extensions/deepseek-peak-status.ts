/**
 * DeepSeek 高低峰期状态栏
 *
 * 官方规则（https://api-docs.deepseek.com/quick_start/pricing）：
 * 周一至周五 UTC 01:00–04:00、06:00–10:00 为高峰期；其余时间为低峰期。
 * 即北京时间工作日 09:00–12:00、14:00–18:00 为高峰期。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "deepseek-peak-status";
const REFRESH_MS = 30_000;

function isDeepSeekPeakTime(now = new Date()): boolean {
	const day = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
	if (day === 0 || day === 6) return false;

	const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
	return (utcHour >= 1 && utcHour < 4) || (utcHour >= 6 && utcHour < 10);
}

function updateStatus(ctx: ExtensionContext): void {
	const theme = ctx.ui.theme;
	if (isDeepSeekPeakTime()) {
		ctx.ui.setStatus(STATUS_KEY, theme.fg("muted", "DeepSeek: 高峰期"));
		return;
	}

	// 用户要求：低峰期用红色醒目提醒使用 DeepSeek。
	ctx.ui.setStatus(STATUS_KEY, theme.fg("error", "DeepSeek: 低峰期 · 建议使用 DeepSeek"));
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", (_event, ctx) => {
		updateStatus(ctx);
		timer = setInterval(() => updateStatus(ctx), REFRESH_MS);
		timer.unref?.();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("deepseek-period", {
		description: "显示 DeepSeek 当前高峰/低峰期状态",
		handler: async (_args, ctx) => {
			const peak = isDeepSeekPeakTime();
			updateStatus(ctx);
			ctx.ui.notify(
				peak
					? "DeepSeek 当前为高峰期（工作日北京时间 09:00–12:00、14:00–18:00）。"
					: "DeepSeek 当前为低峰期，官方价格为高峰期的一半，建议使用 DeepSeek。",
				peak ? "info" : "warning",
			);
		},
	});
}
