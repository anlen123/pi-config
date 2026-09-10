import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai";
import type { Context, Model } from "@earendil-works/pi-ai";

const CHECK_TIMEOUT_MS = 20_000;
const PROBE_TEXT = "Reply with OK only.";

interface CheckResult {
	provider: string;
	providerName: string;
	model: string;
	status: "ok" | "failed";
	latencyMs?: number;
	error?: string;
}

function errorMessage(error: unknown): string {
	let message = error instanceof Error ? error.message : String(error);
	if (/timeout|timed out|aborted/i.test(message)) return "请求超时";
	if (/role ['\"]developer['\"] is not supported/i.test(message)) return "请求格式不兼容：不支持 developer 角色";
	const status = message.match(/(?:^|\b)([45]\d{2})(?::\s*|\s+status code(?: \(([^)]+)\))?)/i);
	if (status) return `HTTP ${status[1]}${status[2] ? `（${status[2]}）` : ""}`;
	message = message
		.replace(/\s*\(request id:\s*[^)]+\)/gi, "")
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return message.slice(0, 120) || "未知错误";
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

function renderReport(results: CheckResult[]): string {
	const successCount = results.filter((result) => result.status === "ok").length;
	const groups = new Map<string, { provider: string; providerName: string; results: CheckResult[] }>();
	for (const result of results) {
		const key = `${result.provider}\0${result.providerName}`;
		const group = groups.get(key) ?? { provider: result.provider, providerName: result.providerName, results: [] };
		group.results.push(result);
		groups.set(key, group);
	}

	const latencyValue = (result: CheckResult): number => result.latencyMs ?? Number.POSITIVE_INFINITY;
	const sortedGroups = [...groups.values()].map((group) => ({
		...group,
		results: [...group.results].sort((a, b) => latencyValue(a) - latencyValue(b) || a.model.localeCompare(b.model)),
	}));
	sortedGroups.sort((a, b) => latencyValue(a.results[0]) - latencyValue(b.results[0]) || a.provider.localeCompare(b.provider));

	const lines = [`模型接口延迟检查  ${successCount}/${results.length} 可用`, ""];
	for (const group of sortedGroups) {
		const groupSuccessCount = group.results.filter((result) => result.status === "ok").length;
		lines.push(`▸ ${group.providerName} (${group.provider})  ${groupSuccessCount}/${group.results.length} 可用`);
		for (const result of group.results) {
			const latency = result.latencyMs === undefined ? "-" : `${result.latencyMs} ms`;
			const marker = result.status === "ok" ? "✓" : "✗";
			const detail = result.status === "ok" ? "" : `  ${result.error ?? "请求失败"}`;
			lines.push(`  ${marker} ${result.model}  ${latency}${detail}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

async function checkModel(model: Model<any>, ctx: ExtensionContext): Promise<CheckResult> {
	const providerName = ctx.modelRegistry.getProviderDisplayName(model.provider) || model.provider;
	const startedAt = performance.now();
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			return { provider: model.provider, providerName, model: model.id, status: "failed", error: errorMessage(auth.error) };
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
				error: errorMessage(response.errorMessage || "模型返回错误"),
			};
		}
		if (response.stopReason === "aborted") {
			return { provider: model.provider, providerName, model: model.id, status: "failed", latencyMs, error: "请求超时" };
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
		description: "查询当前已配置供应商的模型接口延迟（仅列出已配置凭据的供应商）",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("当前模型正在工作，请等待本轮结束后再执行 /check_model。", "warning");
				return;
			}

			try {
				await ctx.modelRegistry.refresh();
			} catch (error) {
				ctx.ui.notify(`重新加载模型配置失败，将使用当前内存中的模型：${errorMessage(error)}`, "warning");
			}

			// 只列出当前 pi 已配置凭据的供应商（有 API key / OAuth / models.json key）
			const models = ctx.modelRegistry.getAvailable();
			if (models.length === 0) {
				ctx.ui.notify("没有找到已配置凭据的模型。", "warning");
				return;
			}

			ctx.ui.setWorkingMessage("正在检查模型接口延迟…");
			ctx.ui.setWorkingVisible(true);
			try {
				const results = await Promise.all(
					models.map((model) => (ctx.signal?.aborted ? Promise.resolve<CheckResult | undefined>(undefined) : checkModel(model, ctx))),
				).then((items) => items.filter((result): result is CheckResult => result !== undefined));
				const report = renderReport(results);
				const successCount = results.filter((r) => r.status === "ok").length;
				ctx.ui.notify(report, successCount > 0 ? "info" : "warning");
			} finally {
				ctx.ui.setWorkingVisible(false);
				ctx.ui.setWorkingMessage();
			}
		},
	});
}
