import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
	accountIdFromToken, countSessionTokens, formatPercent, formatTokens,
	parseWeeklyHeaders, parseWeeklyQuota, quotaConsumed, WEEK_SECONDS,
} from "./status.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const piDir = process.env.PI_PACKAGE_DIR || join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const host = await import(pathToFileURL(join(piDir, "dist/index.js")).href);
const { loadExtensions, discoverAndLoadExtensions } = await import(pathToFileURL(join(piDir, "dist/core/extensions/loader.js")).href);
const { VIRTUAL_MODULES } = await import(pathToFileURL(join(piDir, "dist/core/extensions/virtual-modules.js")).href);
const { visibleWidth } = VIRTUAL_MODULES["@earendil-works/pi-tui"];
const { FooterComponent } = host;
const themeModule = await import(pathToFileURL(join(piDir, "dist/modes/interactive/theme/theme.js")).href);
themeModule.initTheme("dark", false);
const theme = themeModule.theme;
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
const settle = () => new Promise((resolve) => setImmediate(resolve));
const testResetAt = Math.floor(Date.now() / 1000) + 3600;
const bucket = (used, seconds = WEEK_SECONDS) => ({ used_percent: used, limit_window_seconds: seconds, reset_at: testResetAt });
const payload = (used = 1) => ({ rate_limit: { primary_window: bucket(used), secondary_window: null } });
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
const usage = (input = 100, output = 20, cacheRead = 50, cacheWrite = 10) => ({ input, output, cacheRead, cacheWrite, reasoning: output, cacheWrite1h: cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const assistant = (u = usage()) => ({ type: "message", message: { role: "assistant", usage: u, provider: "openai-codex", model: "codex-test", content: [], stopReason: "stop" } });

async function fixture(t, { provider = "openai-codex", hasUI = true, fetchImpl, authImpl, oauth = true } = {}) {
	const originalRender = FooterComponent.prototype.render;
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = fetchImpl || (async (url, options) => {
		calls.push({ url, options });
		return Response.json(payload());
	});
	const result = await loadExtensions([join(extensionDir, "index.ts")], extensionDir);
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
	const extension = result.extensions[0];
	const entries = [assistant()];
	const model = { id: "codex-test", provider, reasoning: true, contextWindow: 200_000 };
	const manager = {
		getSessionId: () => "test-session",
		getEntryCount: () => entries.length,
		getEntries: () => entries,
		getLeafId: () => String(entries.length),
		getCwd: () => "/tmp/project-中文",
		getSessionName: () => "test session",
	};
	const statuses = new Map([["existing-plugin", "Existing status 中文"]]);
	const notifications = [];
	let repaints = 0;
	const ctx = {
		hasUI, model, thinkingLevel: "xhigh",
		sessionManager: { getSessionId: manager.getSessionId, getLeafId: manager.getLeafId, getEntries: manager.getEntries },
		modelRegistry: {
			isUsingOAuth: () => oauth,
			getProviderAuth: authImpl || (async () => ({ auth: { apiKey: token } })),
		},
		ui: {
			theme,
			setStatus: (key, value) => { repaints++; if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
			notify: (text, level) => notifications.push({ text, level }),
		},
	};
	const session = {
		state: { model, thinkingLevel: "xhigh" }, model, sessionManager: manager,
		modelRuntime: { isUsingSubscription: () => provider === "openai-codex" },
		getContextUsage: () => ({ tokens: 1234, percent: 0.6, contextWindow: model.contextWindow }),
	};
	const footerData = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 2,
	};
	const footer = new FooterComponent(session, footerData);
	async function emit(name, event = {}) {
		for (const handler of extension.handlers.get(name) || []) await handler({ type: name, ...event }, ctx);
	}
	t.after(async () => {
		await emit("session_shutdown", { reason: "quit" });
		globalThis.fetch = originalFetch;
		assert.equal(FooterComponent.prototype.render, originalRender, "footer wrapper must be restored");
	});
	await emit("session_start");
	await settle();
	return { ctx, entries, footer, footerData, session, calls, statuses, notifications, emit, originalRender, extension, repaints: () => repaints };
}

test("weekly-only plan: primary is seven days and secondary is null", () => {
	assert.equal(parseWeeklyQuota(payload()).remaining, 99);
});

test("five-hour primary plus weekly secondary selects only weekly", () => {
	const data = { rate_limit: { primary_window: bucket(90, 18000), secondary_window: bucket(24.5) } };
	assert.equal(parseWeeklyQuota(data).remaining, 75.5);
});

test("no valid weekly bucket never fabricates 0% or 100%", () => {
	for (const data of [null, [], {}, { rate_limit: null }, { rate_limit: { primary_window: bucket(15, 18000) } }, { rate_limit: { secondary_window: { used_percent: 4 } } }, { rate_limit: { primary_window: bucket(NaN) } }, { rate_limit: { primary_window: bucket("1") } }]) {
		assert.equal(parseWeeklyQuota(data), undefined);
	}
});

test("percentages clamp and reset timestamps convert seconds to milliseconds", () => {
	assert.equal(parseWeeklyQuota(payload(150)).remaining, 0);
	assert.equal(parseWeeklyQuota(payload(-5)).remaining, 100);
	assert.equal(parseWeeklyQuota({ rate_limit: { primary_window: { ...bucket(0), reset_at: 123 } } }).resetAt, 123000);
});

test("response headers recognize primary/secondary by duration and ignore missing numbers", () => {
	assert.equal(parseWeeklyHeaders({ "X-Codex-Primary-Window-Minutes": "10080", "X-Codex-Primary-Used-Percent": "8.5" }).remaining, 91.5);
	assert.equal(parseWeeklyHeaders({ "x-codex-primary-window-minutes": "300", "x-codex-primary-used-percent": "30", "x-codex-secondary-window-minutes": "10080", "x-codex-secondary-used-percent": "100" }).remaining, 0);
	assert.equal(parseWeeklyHeaders({ "x-codex-primary-window-minutes": "10080", "x-codex-primary-used-percent": "" }), undefined);
	assert.equal(parseWeeklyHeaders({ "x-codex-primary-used-percent": "2" }), undefined);
});

test("account claim is decoded without requiring an auth file", () => {
	assert.equal(accountIdFromToken(token), "test-account");
	for (const invalid of ["bad", "x.e30.x", "x.bm90IGpzb24.x"]) assert.equal(accountIdFromToken(invalid), undefined);
});

test("full-session usage includes all branches, compaction, summaries, tools and standalone usage exactly once", () => {
	const u = usage();
	const entries = [assistant(u), assistant(u), { type: "compaction", usage: u }, { type: "branch_summary", usage: u }, { type: "usage", usage: u }, { type: "message", message: { role: "toolResult", usage: u } }, { type: "message", message: { role: "user" } }, { type: "custom" }];
	assert.equal(countSessionTokens(entries), 6 * 180);
	assert.equal(countSessionTokens([{ type: "usage", usage: { input: NaN, output: -1, cacheRead: undefined, cacheWrite: 10 } }]), 10);
});

test("compact formatting supports small/large values and fractional percentages", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(123400), "123.4k");
	assert.equal(formatTokens(1234000), "1.23M");
	assert.equal(formatTokens(1234000000), "1.23B");
	assert.equal(formatPercent(99), "99");
	assert.equal(formatPercent(99.56), "99.6");
});

test("real Pi loader and built-in footer show suffix after model while preserving other lines", async (t) => {
	const f = await fixture(t);
	const base = f.originalRender.call(f.footer, 150);
	const rendered = f.footer.render(150);
	assert.equal(rendered[0], base[0]);
	assert.equal(rendered[2], base[2]);
	assert.match(plain(rendered[1]), /codex-test • xhigh · 周剩余 99% · Token 180$/);
	assert.equal(f.statuses.size, 1);
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0].url, "https://chatgpt.com/backend-api/wham/usage");
	assert.equal(f.calls[0].options.headers["ChatGPT-Account-Id"], "test-account");
	assert.equal(f.calls[0].options.redirect, "error");
	assert.equal(f.notifications.length, 0);
});

test("rendering fits every width from 1 to 220, including Chinese and ANSI", async (t) => {
	const f = await fixture(t);
	for (let width = 1; width <= 220; width++) {
		for (const line of f.footer.render(width)) assert.ok(visibleWidth(line) <= width, `width=${width}, actual=${visibleWidth(line)}: ${plain(line)}`);
	}
	assert.match(plain(f.footer.render(80)[1]), /codex-test.*周剩余 99%.*Token 180/);
});

test("token count survives compaction and updates after message completion", async (t) => {
	const f = await fixture(t);
	f.entries.push(assistant(usage(1000, 100, 0, 0)), { type: "compaction", usage: usage(200, 30, 0, 0) });
	await f.emit("session_compact");
	assert.match(plain(f.footer.render(150)[1]), /Token 1.5k$/);
	f.entries.push(assistant(usage(100, 20, 0, 0)));
	await f.emit("message_end");
	const command = f.extension.commands.get("codex-status");
	await command.handler("", f.ctx);
	assert.match(f.notifications.at(-1).text, /Token 1,630/);
});

test("unknown quota and failed requests are silent, preserve tokens and never show raw secrets", async (t) => {
	const f = await fixture(t, { fetchImpl: async () => { throw new Error("secret-bearer-token"); } });
	assert.match(plain(f.footer.render(150)[1]), /周剩余 -- · Token 180$/);
	assert.equal(f.notifications.length, 0);
	await f.extension.commands.get("codex-status").handler("", f.ctx);
	assert.equal(f.notifications.at(-1).level, "warning");
	assert.match(f.notifications.at(-1).text, /额度查询失败/);
	assert.doesNotMatch(f.notifications.at(-1).text, /secret-bearer-token/);
});

test("failed refresh marks prior quota stale rather than replacing it with fake values", async (t) => {
	let requests = 0;
	const f = await fixture(t, { fetchImpl: async () => ++requests === 1 ? Response.json(payload()) : new Response("unavailable", { status: 503 }) });
	await f.extension.commands.get("codex-status").handler("", f.ctx);
	assert.match(plain(f.footer.render(150)[1]), /周剩余 99%~/);
	assert.match(f.notifications.at(-1).text, /HTTP 503/);
});

test("expired quota displays unknown instead of stale remaining percentage", async (t) => {
	const data = { rate_limit: { primary_window: { ...bucket(90), reset_at: 1 } } };
	const f = await fixture(t, { fetchImpl: async () => Response.json(data) });
	assert.match(plain(f.footer.render(150)[1]), /周剩余 --/);
});

test("provider headers update quota immediately without another request", async (t) => {
	const f = await fixture(t);
	await f.emit("after_provider_response", { headers: { "x-codex-secondary-window-minutes": "10080", "x-codex-secondary-used-percent": "25" } });
	assert.match(plain(f.footer.render(150)[1]), /周剩余 75%/);
	assert.equal(f.calls.length, 1);
});

test("newer provider headers are not overwritten by an in-flight poll", async (t) => {
	let resolve;
	const f = await fixture(t, { fetchImpl: async () => new Promise((done) => { resolve = done; }) });
	await f.emit("after_provider_response", { headers: { "x-codex-primary-window-minutes": "10080", "x-codex-primary-used-percent": "30" } });
	resolve(Response.json(payload(1)));
	await settle();
	assert.match(plain(f.footer.render(150)[1]), /周剩余 70%/);
});

test("switching away restores footer, switching back installs exactly one suffix", async (t) => {
	const f = await fixture(t);
	f.ctx.model.provider = "anthropic";
	await f.emit("model_select", { model: f.ctx.model });
	assert.equal(FooterComponent.prototype.render, f.originalRender);
	assert.doesNotMatch(plain(f.footer.render(150)[1]), /周剩余|Token/);
	f.ctx.model.provider = "openai-codex";
	await f.emit("model_select", { model: f.ctx.model });
	await settle();
	assert.equal((plain(f.footer.render(150)[1]).match(/周剩余/g) || []).length, 1);
});

test("reload aborts pending network work and old results cannot change the next session", async (t) => {
	let resolve;
	let signal;
	const f = await fixture(t, { fetchImpl: async (_url, options) => { signal = options.signal; return new Promise((done) => { resolve = done; }); } });
	await f.emit("session_shutdown", { reason: "reload" });
	assert.equal(signal.aborted, true);
	assert.equal(FooterComponent.prototype.render, f.originalRender);
	globalThis.fetch = async () => Response.json(payload(20));
	await f.emit("session_start");
	await settle();
	resolve(Response.json(payload(90)));
	await settle();
	assert.match(plain(f.footer.render(150)[1]), /周剩余 80%/);
});

test("other providers do not query or decorate", async (t) => {
	const f = await fixture(t, { provider: "anthropic" });
	assert.equal(f.calls.length, 0);
	assert.equal(FooterComponent.prototype.render, f.originalRender);
});

test("headless sessions do not query or decorate", async (t) => {
	const f = await fixture(t, { hasUI: false });
	assert.equal(f.calls.length, 0);
	assert.equal(FooterComponent.prototype.render, f.originalRender);
});

test("non-OAuth auth does not send an API key to ChatGPT", async (t) => {
	const f = await fixture(t, { oauth: false });
	assert.equal(f.calls.length, 0);
	assert.match(plain(f.footer.render(150)[1]), /周剩余 --/);
});

test("quota consumption measures absolute percentage points and handles zero", () => {
	const before = { remaining: 90, resetAt: 2000 };
	assert.equal(quotaConsumed(before, { remaining: 87, resetAt: 2000 }, 1000), 3);
	assert.equal(quotaConsumed(before, before, 1000), 0);
	assert.equal(formatPercent(quotaConsumed({ remaining: 90.2 }, { remaining: 89.1 }, 1000)), "1.1");
	assert.equal(formatTokens(1_000_000), "1M");
});

test("quota consumption is unknown for missing data, reset boundaries and refills", () => {
	const before = { remaining: 90, resetAt: 2000 };
	assert.equal(quotaConsumed(undefined, before, 1000), undefined);
	assert.equal(quotaConsumed(before, undefined, 1000), undefined);
	assert.equal(quotaConsumed(before, { remaining: 87, resetAt: 3000 }, 1000), undefined);
	assert.equal(quotaConsumed(before, { remaining: 87, resetAt: 2000 }, 2000), undefined);
	assert.equal(quotaConsumed(before, { remaining: 95, resetAt: 2000 }, 1000), undefined);
});

test("a completed dialogue shows the requested full-width parentheses and exact example", async (t) => {
	let request = 0;
	const f = await fixture(t, { fetchImpl: async () => Response.json(payload([10, 10, 13][Math.min(request++, 2)])) });
	f.entries.push(assistant(usage(2_000_000, 50_000, 0, 0)));
	await f.emit("before_agent_start");
	await f.emit("agent_start");
	f.entries.push(assistant(usage(900_000, 100_000, 0, 0)));
	await f.emit("message_end");
	assert.doesNotMatch(plain(f.footer.render(180)[1]), /（.*）/);
	await f.emit("agent_end");
	assert.equal(request, 2, "low-level completion must not finalize dialogue");
	await f.emit("agent_settled", { aborted: false });
	await settle();
	const rendered = plain(f.footer.render(180)[1]);
	assert.match(rendered, /codex-test • xhigh · 周剩余 87%（3%） · Token 3\.05M（1M）$/);
	assert.equal(request, 3, "force refresh at start and final completion");
	assert.equal(f.notifications.length, 0, "automatic summaries stay in the footer");
});

test("one dialogue sums model calls, tool usage, compaction and automatic retry", async (t) => {
	let request = 0;
	const f = await fixture(t, { fetchImpl: async () => Response.json(payload(request++ < 2 ? 10 : 13)) });
	await f.emit("before_agent_start");
	await f.emit("agent_start");
	f.entries.push(assistant(usage()));
	await f.emit("message_end");
	await f.emit("agent_end");
	await f.emit("agent_start");
	assert.equal(request, 2, "retry must not reset baseline or fetch another starting sample");
	f.entries.push(assistant(usage()), { type: "message", message: { role: "toolResult", usage: usage() } }, { type: "compaction", usage: usage() });
	await f.emit("session_compact");
	await f.emit("agent_settled", { aborted: false });
	await settle();
	assert.match(plain(f.footer.render(180)[1]), /周剩余 87%（3%） · Token 900（720）$/);
});

test("only the most recent completed dialogue is shown; running messages keep the prior summary", async (t) => {
	const used = [10, 10, 13, 13, 14];
	let request = 0;
	const f = await fixture(t, { fetchImpl: async () => Response.json(payload(used[Math.min(request++, used.length - 1)])) });
	await f.emit("before_agent_start");
	f.entries.push(assistant(usage()));
	await f.emit("agent_settled");
	await settle();
	assert.match(plain(f.footer.render(180)[1]), /87%（3%）.*Token 360（180）$/);
	await f.emit("before_agent_start");
	f.entries.push(assistant(usage(1000, 100, 0, 0)));
	await f.emit("message_end");
	assert.match(plain(f.footer.render(180)[1]), /（3%）.*（180）$/);
	await f.emit("agent_settled");
	await settle();
	assert.match(plain(f.footer.render(180)[1]), /86%（1%）.*Token 1\.5k（1\.1k）$/);
});

test("zero consumption is displayed as 0%, not treated as missing data", async (t) => {
	const f = await fixture(t);
	await f.emit("before_agent_start");
	await f.emit("agent_settled");
	await settle();
	assert.match(plain(f.footer.render(180)[1]), /99%（0%）.*Token 180（0）$/);
});

test("agent_start without before_agent_start supports programmatic continuations", async (t) => {
	const f = await fixture(t);
	await f.emit("agent_start");
	f.entries.push(assistant(usage()));
	await f.emit("agent_settled");
	await settle();
	assert.match(plain(f.footer.render(180)[1]), /Token 360（180）$/);
});

test("aborted dialogue still reports tokens already spent", async (t) => {
	const f = await fixture(t);
	await f.emit("before_agent_start");
	f.entries.push(assistant(usage(100, 10, 0, 0)));
	await f.emit("agent_settled", { aborted: true });
	await settle();
	assert.match(plain(f.footer.render(180)[1]), /Token 290（110）$/);
});

test("failed starting sample gives unknown percent but precise dialogue tokens", async (t) => {
	let request = 0;
	const f = await fixture(t, { fetchImpl: async () => ++request === 2 ? new Response("unavailable", { status: 503 }) : Response.json(payload(10)) });
	await f.emit("before_agent_start");
	f.entries.push(assistant(usage()));
	await f.emit("agent_settled");
	await settle();
	assert.match(plain(f.footer.render(180)[1]), /90%（--）.*Token 360（180）$/);
});

test("failed ending sample must not claim a false 0% consumption", async (t) => {
	let request = 0;
	const f = await fixture(t, { fetchImpl: async () => ++request === 3 ? new Response("unavailable", { status: 503 }) : Response.json(payload(10)) });
	await f.emit("before_agent_start");
	f.entries.push(assistant(usage()));
	await f.emit("agent_settled");
	await settle();
	assert.match(plain(f.footer.render(180)[1]), /90%~（--）.*Token 360（180）$/);
});

test("a dialogue spanning weekly reset does not display negative or fabricated percent", async (t) => {
	let request = 0;
	const f = await fixture(t, { fetchImpl: async () => {
		const data = payload(++request < 3 ? 10 : 1);
		if (request >= 3) data.rate_limit.primary_window.reset_at += WEEK_SECONDS;
		return Response.json(data);
	} });
	await f.emit("before_agent_start");
	f.entries.push(assistant(usage()));
	await f.emit("agent_settled");
	await settle();
	assert.match(plain(f.footer.render(180)[1]), /99%（--）.*Token 360（180）$/);
});

test("dialogue Token is visible immediately while final quota query is still running", async (t) => {
	let request = 0;
	let resolve;
	const f = await fixture(t, { fetchImpl: async () => ++request < 3 ? Response.json(payload(10)) : new Promise((done) => { resolve = done; }) });
	await f.emit("before_agent_start");
	f.entries.push(assistant(usage()));
	await f.emit("agent_settled");
	await settle();
	assert.match(plain(f.footer.render(180)[1]), /（--）.*Token 360（180）$/);
	resolve(Response.json(payload(13)));
	await settle();
	assert.match(plain(f.footer.render(180)[1]), /87%（3%）.*Token 360（180）$/);
});

test("final sampling waits for an in-flight mid-dialogue poll and then makes a fresh request", async (t) => {
	let request = 0;
	let resolve;
	const f = await fixture(t, { fetchImpl: async () => ++request === 3 ? new Promise((done) => { resolve = done; }) : Response.json(payload(request >= 4 ? 13 : 10)) });
	await f.emit("before_agent_start");
	const command = f.extension.commands.get("codex-status").handler("", f.ctx);
	await settle();
	f.entries.push(assistant(usage()));
	await f.emit("agent_settled");
	resolve(Response.json(payload(11)));
	await command;
	await settle();
	assert.equal(request, 4);
	assert.match(plain(f.footer.render(180)[1]), /87%（3%）.*Token 360（180）$/);
});

test("same-provider model switching preserves the active baseline and finished summary", async (t) => {
	let request = 0;
	const f = await fixture(t, { fetchImpl: async () => Response.json(payload(request++ < 2 ? 10 : 13)) });
	await f.emit("before_agent_start");
	f.entries.push(assistant(usage()));
	f.ctx.model.id = "codex-other";
	await f.emit("model_select");
	await f.emit("agent_start");
	f.entries.push(assistant(usage()));
	await f.emit("agent_settled");
	await settle();
	assert.match(plain(f.footer.render(180)[1]), /codex-other.*87%（3%）.*Token 540（360）$/);
	f.ctx.model.id = "codex-third";
	await f.emit("model_select");
	assert.match(plain(f.footer.render(180)[1]), /codex-third.*（3%）.*（360）$/);
});

test("old dialogue completion cannot overwrite state after reload", async (t) => {
	let request = 0;
	let resolve;
	const f = await fixture(t, { fetchImpl: async () => ++request < 3 ? Response.json(payload(10)) : new Promise((done) => { resolve = done; }) });
	await f.emit("before_agent_start");
	f.entries.push(assistant(usage()));
	await f.emit("agent_settled");
	await settle();
	await f.emit("session_shutdown", { reason: "reload" });
	globalThis.fetch = async () => Response.json(payload(20));
	await f.emit("session_start");
	await settle();
	resolve(Response.json(payload(13)));
	await settle();
	assert.match(plain(f.footer.render(180)[1]), /80% · Token 360$/);
	assert.doesNotMatch(plain(f.footer.render(180)[1]), /（/);
});

test("completed-dialogue parentheses fit every width and leave other footer lines untouched", async (t) => {
	const f = await fixture(t);
	await f.emit("before_agent_start");
	f.entries.push(assistant(usage(900_000, 100_000, 0, 0)));
	await f.emit("agent_settled");
	await settle();
	for (let width = 1; width <= 220; width++) {
		const rendered = f.footer.render(width);
		const base = f.originalRender.call(f.footer, width);
		assert.equal(rendered[0], base[0]);
		assert.equal(rendered[2], base[2]);
		for (const line of rendered) assert.ok(visibleWidth(line) <= width, `width=${width}: ${plain(line)}`);
	}
	assert.match(plain(f.footer.render(100)[1]), /codex-test.*（0%）.*（1M）$/);
});

test("manual status includes precise last dialogue Token and does not recalculate its quota", async (t) => {
	let request = 0;
	const f = await fixture(t, { fetchImpl: async () => Response.json(payload([10, 10, 13, 15][Math.min(request++, 3)])) });
	await f.emit("before_agent_start");
	f.entries.push(assistant(usage(900_000, 100_000, 0, 0)));
	await f.emit("agent_settled");
	await settle();
	await f.extension.commands.get("codex-status").handler("", f.ctx);
	assert.match(f.notifications.at(-1).text, /85%（3%）/);
	assert.match(f.notifications.at(-1).text, /最近完成对话 Token 1,000,000/);
});

test("the next dialogue waits for prior final sampling and uses its own fresh baseline", async (t) => {
	let request = 0;
	let resolve;
	const f = await fixture(t, { fetchImpl: async () => {
		request++;
		if (request === 3) return new Promise((done) => { resolve = done; });
		return Response.json(payload(request < 3 ? 10 : request === 4 ? 13 : 14));
	} });
	await f.emit("before_agent_start");
	f.entries.push(assistant(usage()));
	await f.emit("agent_settled");
	await settle();
	let nextStarted = false;
	const nextStart = f.emit("before_agent_start").then(() => { nextStarted = true; });
	await settle();
	assert.equal(nextStarted, false);
	resolve(Response.json(payload(13)));
	await nextStart;
	await settle();
	assert.match(plain(f.footer.render(180)[1]), /87%（3%）.*Token 360（180）$/);
	f.entries.push(assistant(usage(200, 0, 0, 0)));
	await f.emit("agent_settled");
	await settle();
	assert.equal(request, 5);
	assert.match(plain(f.footer.render(180)[1]), /86%（1%）.*Token 560（200）$/);
});

test("duplicate settled events do not double-count or create another final request", async (t) => {
	const f = await fixture(t);
	await f.emit("before_agent_start");
	f.entries.push(assistant(usage()));
	await f.emit("agent_settled");
	await settle();
	const previous = plain(f.footer.render(180)[1]);
	await f.emit("agent_settled");
	await settle();
	assert.equal(f.calls.length, 3);
	assert.equal(plain(f.footer.render(180)[1]), previous);
});

test("hung auth resolution at dialogue start is bounded by the 12-second timeout", async (t) => {
	let authCalls = 0;
	const f = await fixture(t, { authImpl: async () => ++authCalls === 1 ? { auth: { apiKey: token } } : new Promise(() => {}) });
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const start = f.emit("before_agent_start");
	await settle();
	t.mock.timers.tick(12_000);
	await start;
	f.ctx.modelRegistry.getProviderAuth = async () => ({ auth: { apiKey: token } });
	f.entries.push(assistant(usage()));
	await f.emit("agent_settled");
	await settle();
	assert.match(plain(f.footer.render(180)[1]), /99%（--）.*Token 360（180）$/);
});

test("Pi discovers directory index only, not helper or test files", async () => {
	const temp = mkdtempSync(join(tmpdir(), "pi-codex-status-test-"));
	try {
		const agentDir = join(temp, "agent");
		const cwd = join(temp, "workspace");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		mkdirSync(cwd);
		symlinkSync(extensionDir, join(agentDir, "extensions/codex-status"), "dir");
		const result = await discoverAndLoadExtensions([], cwd, agentDir);
		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions.length, 1);
		assert.equal(result.extensions[0].commands.has("codex-status"), true);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
