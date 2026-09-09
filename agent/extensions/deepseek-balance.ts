/**
 * DeepSeek Balance Status Bar Extension
 *
 * 当当前模型是 DeepSeek 官方 API（api.deepseek.com）的模型时，
 * 查询账户余额并渲染到状态栏（footer / status bar）。
 *
 * 功能：
 * - 自动检测：仅当模型 baseUrl 指向 api.deepseek.com 时启用
 * - 事件驱动刷新：会话启动、切换模型、每轮结束（60s 防抖）
 * - 定时刷新：默认每 5 分钟（可用环境变量 DEEPSEEK_BALANCE_REFRESH_MS 覆盖）
 * - 手动刷新：/balance 命令，notify 显示余额详情（不受当前模型限制，总是查 DeepSeek 官方）
 * - 失败降级：显示上次成功余额 + 失败标记；非 DeepSeek 模型自动清除
 *
 * 余额接口：GET https://api.deepseek.com/user/balance
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "deepseek-balance";
const DEFAULT_REFRESH_MS = 5 * 60 * 1000; // 5 分钟
const MIN_INTERVAL_MS = 30 * 1000; // 事件触发的刷新最小间隔（防抖）

interface BalanceInfo {
	currency: string;
	total_balance: string;
	granted_balance: string;
	topped_up_balance: string;
}

interface BalanceResponse {
	is_available: boolean;
	balance_infos: BalanceInfo[];
}

interface DeepseekAuth {
	apiKey: string;
	baseUrl: string;
}

interface CacheEntry {
	balance?: BalanceResponse;
	error?: string;
	at: number;
}

export default function (pi: ExtensionAPI) {
	const refreshMs = Number(process.env.DEEPSEEK_BALANCE_REFRESH_MS ?? DEFAULT_REFRESH_MS) || DEFAULT_REFRESH_MS;

	let timer: ReturnType<typeof setInterval> | undefined;
	let lastRefresh = 0;
	let inFlight = false;
	let rerunRequested = false;
	let cache: CacheEntry | undefined;

	/** 直接读取 DeepSeek 官方 API 凭据（auth.json / DEEPSEEK_API_KEY），不依赖当前模型。 */
	async function getOfficialDeepseekAuth(ctx: ExtensionContext): Promise<DeepseekAuth | undefined> {
		try {
			const auth = await ctx.modelRegistry.getProviderAuth("deepseek");
			if (auth?.auth?.apiKey) {
				return {
					apiKey: auth.auth.apiKey,
					baseUrl: auth.auth.baseUrl ?? "https://api.deepseek.com",
				};
			}
		} catch {
			// 交给下方返回 undefined 兜底
		}
		return undefined;
	}

	/** 解析当前模型是否 DeepSeek 官方 API，并返回可用的 key 和 baseUrl。 */
	async function resolveDeepseek(ctx: ExtensionContext): Promise<DeepseekAuth | undefined> {
		const model = ctx.model;
		if (!model) return undefined;

		let baseUrls: string[] = [];
		if (model.baseUrl) baseUrls.push(model.baseUrl);

		let apiKey: string | undefined;
		let baseUrl: string | undefined;
		try {
			const auth = await ctx.modelRegistry.getProviderAuth(model.provider);
			if (auth?.auth) {
				if (auth.auth.baseUrl) baseUrl = auth.auth.baseUrl;
				apiKey = auth.auth.apiKey;
				if (baseUrl) baseUrls.push(baseUrl);
			}
		} catch {
			// 忽略 auth 解析错误，交给下方 baseUrl 判断兜底
		}

		if (!baseUrls.some((u) => u && /api\.deepseek\.com/i.test(u))) return undefined;
		if (!apiKey) return undefined;

		return { apiKey, baseUrl: baseUrl ?? model.baseUrl ?? "https://api.deepseek.com" };
	}

	async function fetchBalance(auth: DeepseekAuth): Promise<BalanceResponse> {
		const url = `${auth.baseUrl.replace(/\/+$/, "")}/user/balance`;
		const res = await fetch(url, {
			headers: {
				Authorization: `Bearer ${auth.apiKey}`,
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}${res.status === 401 ? " (API key 无效)" : ""}`);
		}
		return (await res.json()) as BalanceResponse;
	}

	function formatBalance(balance: BalanceResponse): string {
		return balance.balance_infos
			.map((info) => {
				const symbol =
					info.currency === "CNY" ? "¥" : info.currency === "USD" ? "$" : `${info.currency} `;
				return `${symbol}${Number(info.total_balance).toFixed(2)}`;
			})
			.join(" ");
	}

	function render(ctx: ExtensionContext, balance: BalanceResponse | undefined, error: string | undefined) {
		const theme = ctx.ui.theme;
		if (!balance) {
			ctx.ui.setStatus(STATUS_KEY, theme.fg("error", `DS 余额获取失败${error ? ` (${error})` : ""}`));
			return;
		}

		const text = formatBalance(balance);
		const low = balance.balance_infos.some((info) => Number(info.total_balance) < 5);

		let status: string;
		if (!balance.is_available) {
			status = theme.fg("error", `DS ${text} ⚠ 余额不足`);
		} else if (low) {
			status = theme.fg("warning", `DS ${text} (低)`);
		} else {
			status = theme.fg("success", `DS ${text}`);
		}
		if (error) {
			status += theme.fg("dim", " (更新失败)");
		}
		ctx.ui.setStatus(STATUS_KEY, status);
	}

	async function refresh(ctx: ExtensionContext, opts: { force?: boolean } = {}): Promise<void> {
		// 防抖：非强制刷新且间隔过短则跳过
		if (!opts.force && Date.now() - lastRefresh < MIN_INTERVAL_MS) return;
		if (inFlight) {
			// 请求进行中：force 刷新排队重跑，保证切换模型后状态栏一定更新
			if (opts.force) rerunRequested = true;
			return;
		}

		const auth = await resolveDeepseek(ctx);
		if (!auth) {
			// 非 DeepSeek 官方模型：清除状态栏并失效缓存
			ctx.ui.setStatus(STATUS_KEY, undefined);
			cache = undefined;
			lastRefresh = Date.now();
			return;
		}

		inFlight = true;
		try {
			const balance = await fetchBalance(auth);
			cache = { balance, at: Date.now() };
			render(ctx, balance, undefined);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			cache = { ...cache, error: msg, at: Date.now() };
			render(ctx, cache?.balance, msg);
		} finally {
			inFlight = false;
			lastRefresh = Date.now();
			if (rerunRequested) {
				rerunRequested = false;
				refresh(ctx, { force: true });
			}
		}
	}

	// 会话启动：立即刷新并启动定时器（不在 factory 中启动后台资源）
	pi.on("session_start", (_event, ctx) => {
		refresh(ctx, { force: true });
		timer = setInterval(() => refresh(ctx), refreshMs);
		timer.unref?.();
	});

	// 会话结束：清理定时器
	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});

	// 切换模型：重新检测并刷新
	pi.on("model_select", (_event, ctx) => {
		refresh(ctx, { force: true });
	});

	// 每轮结束：静默刷新（受防抖限制，不会频繁请求）
	pi.on("turn_end", (_event, ctx) => {
		refresh(ctx);
	});

	// 手动查询命令：/balance —— 不受当前模型限制，总是查询 DeepSeek 官方余额
	pi.registerCommand("balance", {
		description: "手动查询 DeepSeek 官方账户余额（任意模型下可用）",
		handler: async (_args, ctx) => {
			const auth = await getOfficialDeepseekAuth(ctx);
			if (!auth) {
				ctx.ui.notify("未找到 DeepSeek 官方 API key（auth.json 中 deepseek 项或 DEEPSEEK_API_KEY），无法查询余额", "error");
				return;
			}
			try {
				const balance = await fetchBalance(auth);
				const details = balance.balance_infos
					.map(
						(info) =>
							`${info.currency}: 总余额 ${info.total_balance}（赠金 ${info.granted_balance} / 充值 ${info.topped_up_balance}）`,
					)
					.join("\n");
				const available = balance.is_available ? "可用" : "不足";
				ctx.ui.notify(`DeepSeek 余额（${available}）\n${details}`, balance.is_available ? "info" : "warning");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`余额获取失败: ${msg}`, "error");
			}
		},
	});
}
