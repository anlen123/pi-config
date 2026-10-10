import { Buffer } from "node:buffer";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const WEEK_SECONDS = 7 * 24 * 60 * 60;
export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export interface WeeklyQuota {
	remaining: number;
	resetAt?: number;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as JsonObject
		: undefined;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function quota(used: number, resetAt?: number): WeeklyQuota {
	return { remaining: Math.max(0, Math.min(100, 100 - used)), resetAt };
}

/** Weekly-only plans can put the weekly bucket in primary_window. */
export function parseWeeklyQuota(data: unknown): WeeklyQuota | undefined {
	const rateLimit = object(object(data)?.rate_limit);
	if (!rateLimit) return undefined;
	for (const key of ["primary_window", "secondary_window"]) {
		const window = object(rateLimit[key]);
		if (!window || finite(window.limit_window_seconds) !== WEEK_SECONDS) continue;
		const used = finite(window.used_percent);
		if (used === undefined) continue;
		const resetAt = finite(window.reset_at);
		return quota(used, resetAt !== undefined && resetAt > 0 ? resetAt * 1000 : undefined);
	}
	return undefined;
}

/** Avoid extra polling when a Codex HTTP response already carries quota data. */
export function parseWeeklyHeaders(headers: Record<string, string>): WeeklyQuota | undefined {
	const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
	const number = (key: string): number | undefined => {
		const value = normalized.get(key);
		if (value === undefined || value.trim() === "") return undefined;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	};
	for (const bucket of ["primary", "secondary"]) {
		const prefix = `x-codex-${bucket}`;
		if (number(`${prefix}-window-minutes`) !== WEEK_SECONDS / 60) continue;
		const used = number(`${prefix}-used-percent`);
		if (used === undefined) continue;
		const resetAt = number(`${prefix}-reset-at`);
		return quota(used, resetAt !== undefined && resetAt > 0 ? resetAt * 1000 : undefined);
	}
	return undefined;
}

/** Decode only the account claim; credentials never get logged or persisted. */
export function accountIdFromToken(token: string): string | undefined {
	try {
		const [, encodedPayload] = token.split(".");
		if (!encodedPayload) return undefined;
		const payload = object(JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")));
		const accountId = object(payload?.["https://api.openai.com/auth"])?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

/** Same full-session accounting as Pi, including branches and compaction usage. */
export function countSessionTokens(entries: readonly SessionEntry[]): number {
	let total = 0;
	for (const entry of entries) {
		let usage;
		if (entry.type === "usage") {
			usage = entry.usage;
		} else if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
			usage = entry.message.usage;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			usage = entry.usage;
		}
		if (!usage) continue;
		// Reasoning is already in output; cacheWrite1h is already in cacheWrite.
		for (const value of [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]) {
			if (typeof value === "number" && Number.isFinite(value) && value > 0) total += value;
		}
	}
	return total;
}

/** Absolute percentage-point consumption, not a percentage of the starting balance. */
export function quotaConsumed(before: WeeklyQuota | undefined, after: WeeklyQuota | undefined, observedAt = Date.now()): number | undefined {
	if (!before || !after) return undefined;
	if (before.resetAt !== undefined && before.resetAt <= observedAt) return undefined;
	if (after.resetAt !== undefined && after.resetAt <= observedAt) return undefined;
	if (before.resetAt !== undefined && after.resetAt !== undefined && before.resetAt !== after.resetAt) return undefined;
	const consumed = before.remaining - after.remaining;
	// A refill/reset cannot be attributed to this dialogue; do not report negative consumption.
	return Number.isFinite(consumed) && consumed >= 0 ? consumed : undefined;
}

export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000_000) return `${Number((tokens / 1_000_000_000).toFixed(2))}B`;
	if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`;
	if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(1))}k`;
	return String(Math.round(tokens));
}

export function formatPercent(percent: number): string {
	return Number(percent.toFixed(1)).toString();
}
