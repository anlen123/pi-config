import type { ExtensionAPI, ExtensionContext } from "@hhyy668/pi-coding-agent";
import { complete } from "@hhyy668/pi-ai";
import type { Context, Model } from "@hhyy668/pi-ai";

const CHECK_TIMEOUT_MS = 20_000;
const PROBE_TEXT = "Reply with OK only.";

interface CheckResult {
	provider: string;
	providerName: string;
	model: string;
	status: "ok" | "failed" | "unconfigured";
	latencyMs?: number;
	error?: string;
}

function escapeTableCell(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/[\r\n]+/g, " ").slice(0, 180) || "unknown error";
}

function buildProbeContext(): Context {
	return {
		systemPrompt: "You are a model availability probe. Follow the user request exactly and return only OK.",
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: PROBE_TEXT }],
				timestamp: Date.now(),
			},
		],
	};
}

function renderTable(results: CheckResult[]): string {
	const lines = [
		"| Provider | Model | Status | First response | Details |",
		"| --- | --- | --- | ---: | --- |",
	];
	for (const result of results) {
		const status = result.status === "ok" ? "OK" : result.status === "unconfigured" ? "未配置凭据" : "失败";
		const latency = result.latencyMs === undefined ? "-" : `${result.latencyMs} ms`;
		const details = result.error ?? "可用";
		lines.push(
			`| ${escapeTableCell(result.providerName)} (${escapeTableCell(result.provider)}) | ${escapeTableCell(result.model)} | ${status} | ${latency} | ${escapeTableCell(details)} |`,
		);
	}
	return lines.join("\n");
}

async function checkModel(model: Model<any>, ctx: ExtensionContext): Promise<CheckResult> {
	const providerName = ctx.modelRegistry.getProviderDisplayName(model.provider) || model.provider;
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		return { provider: model.provider, providerName, model: model.id, status: "unconfigured", error: "API key 未配置" };
	}

	const startedAt = performance.now();
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			return { provider: model.provider, providerName, model: model.id, status: "failed", error: auth.error };
		}
		const response = await complete(model, buildProbeContext(), {
			apiKey: auth.apiKey,
			env: auth.env,
			headers: auth.headers,
			signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
			maxTokens: 8,
			cacheRetention: "none",
			maxRetries: 0,
		});
		const latencyMs = Math.round(performance.now() - startedAt);
		if (response.stopReason === "error") {
			return {
				provider: model.provider,
				providerName,
				model: model.id,
				status: "failed",
				latencyMs,
				error: response.errorMessage || "模型返回错误",
			};
		}
		if (response.stopReason === "aborted") {
			return { provider: model.provider, providerName, model: model.id, status: "failed", latencyMs, error: "请求超时或被中止" };
		}
		return { provider: model.provider, providerName, model: model.id, status: "ok", latencyMs };
	} catch (error) {
		return {
			provider: model.provider,
			providerName,
			model: model.id,
			status: "failed",
			latencyMs: Math.round(performance.now() - startedAt),
			error: errorMessage(error),
		};
	}
}

export default function registerCheckModel(pi: ExtensionAPI) {
	pi.registerCommand("check_model", {
		description: "查询所有已注册模型的接口延迟",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("当前模型正在工作，请等待本轮结束后再执行 /check_model。", "warning");
				return;
			}

			try {
				ctx.modelRegistry.refresh();
			} catch (error) {
				ctx.ui.notify(`重新加载模型配置失败，将使用当前内存中的模型：${errorMessage(error)}`, "warning");
			}

			const models = ctx.modelRegistry.getAll();
			if (models.length === 0) {
				ctx.ui.notify("没有找到已注册的模型。", "warning");
				return;
			}

			ctx.ui.setWorkingMessage("正在检查模型接口延迟…");
			ctx.ui.setWorkingVisible(true);
			try {
				const results = await Promise.all(
					models.map((model) => (ctx.signal?.aborted ? Promise.resolve<CheckResult | undefined>(undefined) : checkModel(model, ctx))),
				).then((items) => items.filter((result): result is CheckResult => result !== undefined));
				const table = renderTable(results);
				const successCount = results.filter((result) => result.status === "ok").length;
				ctx.ui.notify(`模型接口延迟（${successCount}/${results.length} 可用）\n\n${table}`, successCount > 0 ? "info" : "warning");
			} finally {
				ctx.ui.setWorkingVisible(false);
				ctx.ui.setWorkingMessage();
			}
		},
	});
}
