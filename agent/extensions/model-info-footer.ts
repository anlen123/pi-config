/**
 * Model Info Footer - 启动时自动在底部状态栏显示模型信息
 *
 * 显示内容：
 * - 模型名称 (provider/model)
 * - 上下文窗口大小 + 使用率百分比
 * - Token 用量 (输入 ↑ / 输出 ↓ / 总计 Σ)
 * - 费用 ($)
 * - 思考级别 (🧠图标)
 *
 * 使用 /model-info 手动切换开关
 */

import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

let enabled = false;
let requestRender: (() => void) | null = null;

/**
 * 构建 footer 渲染器
 */
function setupFooter(ctx: any, pi: any, tui: any, theme: any, footerData: any) {
	requestRender = () => tui.requestRender();

	// Git 分支变更时重渲染
	const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

	return {
		dispose: () => {
			requestRender = null;
			unsubBranch();
		},
		invalidate() {},
		render(width: number): string[] {
			// ===== Token 用量统计 =====
			let inputTokens = 0;
			let outputTokens = 0;
			let totalCost = 0;
			for (const e of ctx.sessionManager.getBranch()) {
				if (e.type === "message" && e.message.role === "assistant") {
					const m = e.message as AssistantMessage;
					inputTokens += m.usage.input;
					outputTokens += m.usage.output;
					totalCost += m.usage.cost.total;
				}
			}
			const totalTokens = inputTokens + outputTokens;

			// ===== 数字格式化 =====
			const fmt = (n: number) => {
				if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
				if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
				return `${n}`;
			};

			// ===== 模型信息 =====
			const model: Model | undefined = ctx.model;
			const modelName = model ? `${model.provider}/${model.id}` : "?";
			const ctxWindow = model?.contextWindow ?? 0;
			const ctxStr = ctxWindow > 0 ? `${fmt(ctxWindow)}ctx` : "";

			// ===== 思考级别图标 =====
			const thinking = ctx.thinkingLevel ?? "off";
			const thinkingIcons: Record<string, string> = {
				off: "○", minimal: "◐", low: "◑", medium: "◒", high: "◓", xhigh: "●", max: "⬤",
			};
			const thinkingIcon = thinkingIcons[thinking] ?? thinking;

			// ===== 配色简写 =====
			const dim = (s: string) => theme.fg("dim", s);
			const muted = (s: string) => theme.fg("muted", s);
			const accent = (s: string) => theme.fg("accent", s);
			const success = (s: string) => theme.fg("success", s);
			const warning = (s: string) => theme.fg("warning", s);

			// ===== 左侧：模型 + 上下文窗口 + 思考级别 =====
			const left = accent(modelName) + " " + dim(ctxStr) + " " + muted(`🧠${thinkingIcon}`);

			// ===== 右侧：Token 用量 + 费用 =====
			const rightParts: string[] = [];
			if (totalTokens > 0) {
				// 上下文使用率
				if (ctxWindow > 0) {
					const usagePct = Number(((totalTokens / ctxWindow) * 100).toFixed(0));
					const colorFn = usagePct > 85 ? warning : usagePct > 60 ? muted : dim;
					rightParts.push(colorFn(`${usagePct}%`));
				}
				rightParts.push(
					muted(`↑${fmt(inputTokens)}`) +
						" " +
						muted(`↓${fmt(outputTokens)}`) +
						" " +
						dim(`Σ${fmt(totalTokens)}`)
				);
			}
			if (totalCost > 0) {
				rightParts.push(success(`$${totalCost.toFixed(4)}`));
			}
			const right = rightParts.join("  ");

			// ===== 拼接 =====
			const lw = visibleWidth(left);
			const rw = visibleWidth(right);
			const pad = " ".repeat(Math.max(1, width - lw - rw));
			return [truncateToWidth(left + pad + right, width)];
		},
	};
}

export default function (pi: ExtensionAPI) {
	// ===== 注册切换命令 =====
	pi.registerCommand("model-info", {
		description: "切换底部模型信息显示 (模型/上下文窗口/Token/费用/思考级别)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				ctx.ui.setFooter((tui, theme, footerData) => setupFooter(ctx, pi, tui, theme, footerData));
				ctx.ui.notify("✅ 模型信息栏已开启", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("↩ 已恢复默认底部栏", "info");
			}
		},
	});

	// ===== 事件监听：在关键事件后触发 footer 重渲染 =====
	pi.on("agent_end", () => requestRender?.());
	pi.on("agent_settled", () => requestRender?.());
	pi.on("model_select", () => requestRender?.());
	pi.on("thinking_level_select", () => requestRender?.());

	// ===== 会话启动时自动开启 =====
	pi.on("session_start", async (_event, ctx) => {
		if (!enabled) {
			enabled = true;
			ctx.ui.setFooter((tui, theme, footerData) => setupFooter(ctx, pi, tui, theme, footerData));
		}
	});
}
