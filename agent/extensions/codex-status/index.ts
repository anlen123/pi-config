import { FooterComponent, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	accountIdFromToken,
	countSessionTokens,
	formatPercent,
	formatTokens,
	parseWeeklyHeaders,
	parseWeeklyQuota,
	quotaConsumed,
	USAGE_URL,
	type WeeklyQuota,
} from "./status.ts";

const PROVIDER = "openai-codex";
const POLL_MS = 60_000;
const TIMEOUT_MS = 12_000;
const REPAINT_KEY = "codex-status-refresh";

interface DialogueBaseline {
	tokens: number;
	quota?: WeeklyQuota;
}

interface DialogueSummary {
	tokens: number;
	percent?: number;
}

/** Auth resolution is not cancellable through ModelRegistry, so bound our wait too. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new Error("额度查询超时"));
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		operation.then(
			(value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
			(error) => { signal.removeEventListener("abort", onAbort); reject(error); },
		);
	});
}

/** Append to the existing model line without replacing Pi's footer or other statuses. */
export default function codexStatus(pi: ExtensionAPI) {
	let context: ExtensionContext | undefined;
	let weekly: WeeklyQuota | undefined;
	let updatedAt = 0;
	let lastAttempt = 0;
	let problem: string | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let controller: AbortController | undefined;
	let pending: Promise<void> | undefined;
	let revision = 0;
	let quotaVersion = 0;
	let restoreFooter: (() => void) | undefined;
	let tokenCache: { sessionId: string; leafId: string | null; tokens: number } | undefined;
	let activeDialogue: DialogueBaseline | undefined;
	let lastDialogue: DialogueSummary | undefined;

	function repaint() {
		// Removing our (never displayed) status key also requests a TUI render.
		context?.ui.setStatus(REPAINT_KEY, undefined);
	}

	function tokens(ctx: ExtensionContext) {
		const manager = ctx.sessionManager;
		const sessionId = manager.getSessionId();
		const leafId = manager.getLeafId();
		if (!tokenCache || tokenCache.sessionId !== sessionId || tokenCache.leafId !== leafId) {
			tokenCache = { sessionId, leafId, tokens: countSessionTokens(manager.getEntries()) };
		}
		return tokenCache.tokens;
	}

	function quotaText(compact = false) {
		const expired = weekly?.resetAt !== undefined && Date.now() >= weekly.resetAt;
		const stale = Boolean(problem) || expired || (updatedAt > 0 && Date.now() - updatedAt > POLL_MS * 3);
		let value = "--";
		if (weekly && !expired) value = `${formatPercent(weekly.remaining)}%${stale ? "~" : ""}`;
		const delta = lastDialogue ? `（${lastDialogue.percent === undefined ? "--" : `${formatPercent(lastDialogue.percent)}%`}）` : "";
		return `${compact ? "周" : "周剩余 "}${value}${delta}`;
	}

	function tokenText(total: string, compact = false) {
		const delta = lastDialogue ? `（${formatTokens(lastDialogue.tokens)}）` : "";
		return `${compact ? "T" : "Token"} ${total}${delta}`;
	}

	function decorateFooter() {
		if (restoreFooter) return;
		const original = FooterComponent.prototype.render;
		const decorated = function (this: FooterComponent, width: number): string[] {
			const lines = original.call(this, width);
			const ctx = context;
			if (!ctx || ctx.model?.provider !== PROVIDER || lines.length < 2 || width < 1) return lines;

			const total = formatTokens(tokens(ctx));
			const theme: Theme = ctx.ui.theme;
			let color: "dim" | "error" | "warning" | "success" = "dim";
			if (!problem && weekly && (weekly.resetAt === undefined || Date.now() < weekly.resetAt)) {
				if (weekly.remaining <= 10) color = "error";
				else if (weekly.remaining <= 25) color = "warning";
				else color = "success";
			}
			let suffix = ` · ${theme.fg(color, quotaText())} · ${theme.fg("dim", tokenText(total))}`;
			if (visibleWidth(suffix) + visibleWidth(ctx.model.id) + 2 > width) {
				suffix = ` · ${theme.fg(color, quotaText(true))} · ${theme.fg("dim", tokenText(total, true))}`;
			}

			const available = Math.max(0, width - visibleWidth(suffix));
			const reduced = available > 0 ? original.call(this, available)[1] : "";
			if (reduced.includes(ctx.model.id)) {
				lines[1] = truncateToWidth(reduced + suffix, width, "");
			} else {
				// Pi normally prioritizes left-hand stats on narrow terminals. Here keep
				// the model and requested counters visible, trimming the left stats first.
				const label = ctx.model.id + (ctx.model.reasoning ? ` • ${ctx.thinkingLevel ?? "off"}` : "");
				const right = theme.fg("dim", label) + suffix;
				const room = width - visibleWidth(right) - 2;
				if (room > 0) {
					const left = truncateToWidth(lines[1].split(/ {2,}/)[0], room, "…");
					lines[1] = left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
				} else {
					const model = truncateToWidth(theme.fg("dim", ctx.model.id), available, "…");
					lines[1] = truncateToWidth(model + suffix, width, "");
				}
			}
			return lines;
		};
		FooterComponent.prototype.render = decorated;
		restoreFooter = () => {
			// Do not overwrite a subsequent decorator installed by another extension.
			if (FooterComponent.prototype.render === decorated) FooterComponent.prototype.render = original;
			restoreFooter = undefined;
		};
	}

	async function refresh(force = false): Promise<void> {
		const ctx = context;
		const model = ctx?.model;
		if (!ctx?.hasUI || model?.provider !== PROVIDER) return;
		if (pending) {
			const queuedRevision = revision;
			await pending;
			// A dialogue endpoint needs a sample requested after the boundary,
			// not a poll that was already running while tokens were being spent.
			if (force && revision === queuedRevision) return refresh(true);
			return;
		}
		if (!force && Date.now() - lastAttempt < POLL_MS) return;
		lastAttempt = Date.now();
		const currentRevision = revision;
		const currentQuotaVersion = quotaVersion;
		const abort = new AbortController();
		controller = abort;
		const timeout = setTimeout(() => abort.abort(), TIMEOUT_MS);
		timeout.unref?.();

		const request = (async () => {
			try {
				if (!ctx.modelRegistry.isUsingOAuth(model)) throw new Error("需要 Codex OAuth 登录");
				// Pi serializes OAuth refresh; do not read/write auth.json ourselves.
				const resolved = await abortable(ctx.modelRegistry.getProviderAuth(PROVIDER), abort.signal);
				if (abort.signal.aborted || revision !== currentRevision) return;
				const access = resolved?.auth.apiKey;
				if (!access) throw new Error("未获取到 Codex 登录凭据");
				const authHeaders = Object.entries(resolved?.auth.headers ?? {});
				const account = authHeaders.find(([key]) => key.toLowerCase() === "chatgpt-account-id")?.[1]
					?? accountIdFromToken(access);
				if (!account) throw new Error("无法识别 Codex 账号");
				const response = await fetch(USAGE_URL, {
					headers: { Authorization: `Bearer ${access}`, "ChatGPT-Account-Id": account, Accept: "application/json" },
					signal: abort.signal,
					redirect: "error",
				});
				if (!response.ok) {
					await response.body?.cancel();
					throw new Error(`额度接口 HTTP ${response.status}`);
				}
				const quota = parseWeeklyQuota(await response.json());
				if (!quota) throw new Error("接口未返回周额度");
				// A provider response received during polling is a newer observation.
				if (revision !== currentRevision || quotaVersion !== currentQuotaVersion) return;
				weekly = quota;
				updatedAt = Date.now();
				problem = undefined;
				quotaVersion++;
			} catch (error) {
				if (revision !== currentRevision || quotaVersion !== currentQuotaVersion) return;
				// Never surface arbitrary network errors that might contain credentials.
				if (abort.signal.aborted) problem = "额度查询超时";
				else if (error instanceof Error && /^(需要|未获取到|无法识别|额度接口 HTTP|接口未返回)/.test(error.message)) problem = error.message;
				else problem = "额度查询失败（网络或接口异常）";
			} finally {
				clearTimeout(timeout);
				if (revision === currentRevision) {
					controller = undefined;
					repaint();
				}
			}
		})();
		pending = request;
		try {
			await request;
		} finally {
			if (pending === request) pending = undefined;
		}
	}

	async function startDialogue(ctx: ExtensionContext) {
		if (!context || ctx.model?.provider !== PROVIDER || activeDialogue) return;
		const baseline: DialogueBaseline = { tokens: tokens(ctx) };
		activeDialogue = baseline;
		const startedRevision = revision;
		// These start events are awaited by Pi: sample quota before the first
		// model request. Repeated agent_start events from retries keep this baseline.
		await refresh(true);
		if (revision === startedRevision && activeDialogue === baseline && !problem && weekly) {
			baseline.quota = { ...weekly };
		}
	}

	function finishDialogue(ctx: ExtensionContext) {
		const baseline = activeDialogue;
		if (!context || ctx.model?.provider !== PROVIDER || !baseline) return;
		activeDialogue = undefined;
		tokenCache = undefined;
		const summary: DialogueSummary = { tokens: Math.max(0, tokens(ctx) - baseline.tokens) };
		lastDialogue = summary;
		const finishedRevision = revision;
		repaint();
		// Display Token immediately; quota is updated in the background so Pi
		// becomes idle without waiting on another network request.
		void refresh(true).then(() => {
			if (revision !== finishedRevision || lastDialogue !== summary) return;
			if (!problem) summary.percent = quotaConsumed(baseline.quota, weekly);
			repaint();
		});
	}

	function deactivate() {
		revision++;
		if (timer) clearInterval(timer);
		timer = undefined;
		controller?.abort();
		controller = undefined;
		pending = undefined;
		restoreFooter?.();
		context = undefined;
		weekly = undefined;
		updatedAt = 0;
		lastAttempt = 0;
		problem = undefined;
		tokenCache = undefined;
		activeDialogue = undefined;
		lastDialogue = undefined;
	}

	function activate(ctx: ExtensionContext) {
		if (context && ctx.hasUI && ctx.model?.provider === PROVIDER && ctx.sessionManager.getSessionId() === context.sessionManager.getSessionId()) {
			// Switching models within Codex must not lose the dialogue baseline
			// or the most recently completed dialogue's counters.
			context = ctx;
			tokenCache = undefined;
			repaint();
			void refresh();
			return;
		}
		deactivate();
		if (!ctx.hasUI || ctx.model?.provider !== PROVIDER) return;
		context = ctx;
		decorateFooter();
		repaint();
		void refresh(true);
		timer = setInterval(() => { repaint(); void refresh(); }, POLL_MS);
		timer.unref?.();
	}

	pi.on("session_start", (_event, ctx) => activate(ctx));
	pi.on("model_select", (_event, ctx) => activate(ctx));
	pi.on("before_agent_start", (_event, ctx) => startDialogue(ctx));
	pi.on("agent_start", (_event, ctx) => startDialogue(ctx));
	pi.on("message_end", () => { tokenCache = undefined; repaint(); });
	pi.on("session_compact", () => { tokenCache = undefined; repaint(); });
	// agent_end is only a low-level boundary: retries/continuations can follow.
	pi.on("agent_settled", (_event, ctx) => finishDialogue(ctx));
	pi.on("session_shutdown", () => deactivate());
	pi.on("after_provider_response", (event, ctx) => {
		if (!context || ctx.model?.provider !== PROVIDER) return;
		const quota = parseWeeklyHeaders(event.headers);
		if (!quota) return;
		weekly = quota;
		updatedAt = Date.now();
		problem = undefined;
		quotaVersion++;
		repaint();
	});

	pi.registerCommand("codex-status", {
		description: "刷新 Codex 周额度，查看本会话 Token 消耗",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (ctx.model?.provider !== PROVIDER) {
				ctx.ui.notify("请先切换到 openai-codex 模型。", "info");
				return;
			}
			await refresh(true);
			const count = tokens(ctx);
			const delta = lastDialogue ? `；最近完成对话 Token ${lastDialogue.tokens.toLocaleString("en-US")}` : "";
			ctx.ui.notify(`${quotaText()}；本会话 Token ${count.toLocaleString("en-US")}（输入 + 输出 + 缓存）${delta}${problem ? `；${problem}` : ""}`, problem ? "warning" : "info");
		},
	});
}
