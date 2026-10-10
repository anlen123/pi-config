import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import dialogueTimer, { STATUS_KEY } from "./index.ts";
import { formatElapsed } from "./timer.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const piDir = process.env.PI_PACKAGE_DIR || join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const host = await import(pathToFileURL(join(piDir, "dist/index.js")).href);
const { loadExtensions, discoverAndLoadExtensions } = await import(pathToFileURL(join(piDir, "dist/core/extensions/loader.js")).href);
const { VIRTUAL_MODULES } = await import(pathToFileURL(join(piDir, "dist/core/extensions/virtual-modules.js")).href);
const { visibleWidth } = VIRTUAL_MODULES["@earendil-works/pi-tui"];
const themeModule = await import(pathToFileURL(join(piDir, "dist/modes/interactive/theme/theme.js")).href);
themeModule.initTheme("dark", false);
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ hasUI = true, mode = "tui" } = {}) {
	let time = 0;
	let sessionId = "session-one";
	const handlers = new Map();
	const statuses = new Map([["other-extension", "Other status"]]);
	const writes = [];
	const ctx = {
		hasUI, mode, model: { provider: "openai-codex" },
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			setStatus: (key, text) => { writes.push({ key, text }); if (text === undefined) statuses.delete(key); else statuses.set(key, text); },
			notify: () => { throw new Error("timer must not emit notifications"); },
		},
	};
	dialogueTimer({ on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event); } }, () => time);
	return {
		ctx, statuses, writes,
		advance: (milliseconds) => { time += milliseconds; },
		switchSession: (id) => { sessionId = id; },
		emit: (name, event = {}) => handlers.get(name)?.({ type: name, ...event }, ctx),
	};
}

test("m:ss formatting pads seconds, rounds down and keeps minutes beyond an hour", () => {
	for (const [milliseconds, expected] of [[0, "0:00"], [999, "0:00"], [1000, "0:01"], [9000, "0:09"], [59999, "0:59"], [60000, "1:00"], [65000, "1:05"], [3603000, "60:03"], [3903000, "65:03"]]) {
		assert.equal(formatElapsed(milliseconds), expected);
	}
	for (const invalid of [-1, NaN, Infinity]) assert.equal(formatElapsed(invalid), "0:00");
});

test("no duration is shown before a dialogue has completed", () => {
	const f = fixture();
	f.emit("session_start");
	assert.equal(f.statuses.has(STATUS_KEY), false);
	f.emit("agent_start");
	f.advance(65000);
	f.emit("agent_end");
	assert.equal(f.statuses.has(STATUS_KEY), false);
});

test("one completed dialogue displays 1:05 in the dedicated footer status", () => {
	const f = fixture();
	f.emit("agent_start");
	f.advance(65000);
	f.emit("agent_settled", { aborted: false });
	assert.equal(f.statuses.get(STATUS_KEY), "本次耗时 1:05");
	assert.equal(f.statuses.get("other-extension"), "Other status");
});

test("start timestamp zero is valid, including sub-second responses", () => {
	const f = fixture();
	f.emit("agent_start");
	f.advance(999);
	f.emit("agent_settled");
	assert.equal(f.statuses.get(STATUS_KEY), "本次耗时 0:00");
});

test("automatic retries and continuations do not restart the first timestamp", () => {
	const f = fixture();
	f.emit("agent_start");
	f.advance(5000);
	f.emit("turn_end");
	f.emit("agent_end");
	f.advance(5000);
	f.emit("agent_start");
	f.advance(55000);
	f.emit("agent_settled");
	assert.equal(f.statuses.get(STATUS_KEY), "本次耗时 1:05");
});

test("a running second dialogue retains the last result until completion", () => {
	const f = fixture();
	f.emit("agent_start");
	f.advance(65000);
	f.emit("agent_settled");
	f.advance(120000); // Idle/user-typing time must not enter the second duration.
	f.emit("agent_start");
	f.advance(9000);
	assert.equal(f.statuses.get(STATUS_KEY), "本次耗时 1:05");
	f.emit("agent_settled");
	assert.equal(f.statuses.get(STATUS_KEY), "本次耗时 0:09");
});

test("aborted dialogues still display the time already spent", () => {
	const f = fixture();
	f.emit("agent_start");
	f.advance(12000);
	f.emit("agent_settled", { aborted: true });
	assert.equal(f.statuses.get(STATUS_KEY), "本次耗时 0:12");
});

test("duplicate or unsolicited settled events do not invent or change a duration", () => {
	const f = fixture();
	f.emit("agent_settled");
	assert.equal(f.statuses.has(STATUS_KEY), false);
	f.emit("agent_start");
	f.advance(9000);
	f.emit("agent_settled");
	f.advance(60000);
	f.emit("agent_settled");
	assert.equal(f.statuses.get(STATUS_KEY), "本次耗时 0:09");
});

test("all providers are supported and model switching does not interrupt the timer", () => {
	const f = fixture();
	f.emit("agent_start");
	f.advance(1000);
	f.ctx.model.provider = "anthropic";
	f.emit("model_select");
	f.advance(1000);
	f.emit("agent_settled");
	assert.equal(f.statuses.get(STATUS_KEY), "本次耗时 0:02");
});

test("wall clock corrections cannot change elapsed time", (t) => {
	let wallClock = 100000;
	t.mock.method(Date, "now", () => wallClock);
	const f = fixture();
	f.emit("agent_start");
	wallClock = 1;
	f.advance(65000);
	f.emit("agent_settled");
	assert.equal(f.statuses.get(STATUS_KEY), "本次耗时 1:05");
});

for (const mode of ["rpc", "json", "print"]) {
	test(`non-terminal ${mode} mode does not write status`, () => {
		const f = fixture({ mode });
		f.emit("session_start");
		f.emit("agent_start");
		f.advance(65000);
		f.emit("agent_settled");
		f.emit("session_shutdown");
		assert.equal(f.writes.length, 0);
	});
}

test("headless sessions do not touch UI", () => {
	const f = fixture({ hasUI: false });
	f.emit("session_start");
	f.emit("agent_start");
	f.advance(65000);
	f.emit("agent_settled");
	f.emit("session_shutdown");
	assert.equal(f.writes.length, 0);
});

for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
	test(`shutdown ${reason} removes only our status and resets in-flight timing`, () => {
		const f = fixture();
		f.emit("agent_start");
		f.advance(9000);
		f.emit("agent_settled");
		f.emit("agent_start");
		f.emit("session_shutdown", { reason });
		f.advance(60000);
		f.emit("agent_settled");
		assert.equal(f.statuses.has(STATUS_KEY), false);
		assert.equal(f.statuses.get("other-extension"), "Other status");
	});
}

test("session_start clears prior result and a new session gets a new baseline", () => {
	const f = fixture();
	f.emit("agent_start");
	f.advance(65000);
	f.emit("agent_settled");
	f.switchSession("session-two");
	f.emit("session_start");
	assert.equal(f.statuses.has(STATUS_KEY), false);
	f.emit("agent_start");
	f.advance(3000);
	f.emit("agent_settled");
	assert.equal(f.statuses.get(STATUS_KEY), "本次耗时 0:03");
});

test("a stale settlement for a different session cannot publish the old run", () => {
	const f = fixture();
	f.emit("agent_start");
	f.switchSession("session-two");
	f.advance(65000);
	f.emit("agent_settled");
	assert.equal(f.statuses.has(STATUS_KEY), false);
});

test("Pi auto-discovers the directory's index but not helper/test modules", async () => {
	const temp = mkdtempSync(join(tmpdir(), "pi-dialogue-timer-test-"));
	try {
		const agentDir = join(temp, "agent");
		const cwd = join(temp, "workspace");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		mkdirSync(cwd);
		symlinkSync(extensionDir, join(agentDir, "extensions/dialogue-timer"), "dir");
		const result = await discoverAndLoadExtensions([], cwd, agentDir);
		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions.length, 1);
		assert.equal(result.extensions[0].handlers.has("agent_settled"), true);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("actual Pi loader/footer shows timer alongside Codex quota/Token without conflicts", async (t) => {
	let clock = 1000;
	t.mock.method(performance, "now", () => clock);
	const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
	const resetAt = Math.floor(Date.now() / 1000) + 3600;
	t.mock.method(globalThis, "fetch", async () => Response.json({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 604800, reset_at: resetAt }, secondary_window: null } }));
	const originalRender = host.FooterComponent.prototype.render;
	const result = await loadExtensions([join(extensionDir, "index.ts"), join(extensionDir, "../codex-status/index.ts")], extensionDir);
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 2);
	const entries = [];
	const statuses = new Map([["existing-status", "Existing status 中文"]]);
	const model = { provider: "openai-codex", id: "codex-test", reasoning: true, contextWindow: 200000 };
	const manager = {
		getSessionId: () => "integration-session", getLeafId: () => String(entries.length),
		getEntryCount: () => entries.length, getEntries: () => entries,
		getCwd: () => "/tmp/timer-中文", getSessionName: () => "timer test",
	};
	const ctx = {
		hasUI: true, mode: "tui", model, thinkingLevel: "xhigh", sessionManager: manager,
		modelRegistry: { isUsingOAuth: () => true, getProviderAuth: async () => ({ auth: { apiKey: access } }) },
		ui: {
			theme: themeModule.theme,
			setStatus: (key, text) => { if (text === undefined) statuses.delete(key); else statuses.set(key, text); },
			notify: () => { throw new Error("automatic timer must not notify"); },
		},
	};
	async function emit(name, event = {}) {
		for (const extension of result.extensions) for (const handler of extension.handlers.get(name) || []) await handler({ type: name, ...event }, ctx);
	}
	t.after(async () => { await emit("session_shutdown", { reason: "quit" }); assert.equal(host.FooterComponent.prototype.render, originalRender); });
	const session = { state: { model, thinkingLevel: "xhigh" }, model, sessionManager: manager, modelRuntime: { isUsingSubscription: () => true }, getContextUsage: () => ({ tokens: 120, percent: 0.1, contextWindow: 200000 }) };
	const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => statuses, getAvailableProviderCount: () => 2 };
	const footer = new host.FooterComponent(session, footerData);
	await emit("session_start");
	await settle();
	await emit("before_agent_start");
	await emit("agent_start");
	entries.push({ type: "message", message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
	clock = 66000;
	await emit("agent_end");
	assert.equal(statuses.has(STATUS_KEY), false);
	await emit("agent_settled", { aborted: false });
	await settle();
	const lines = footer.render(180);
	assert.match(plain(lines[1]), /周剩余 99%（0%） · Token 120（120）/);
	assert.match(plain(lines[2]), /本次耗时 1:05/);
	assert.match(plain(lines[2]), /Existing status 中文/);
	for (let width = 1; width <= 180; width++) for (const line of footer.render(width)) assert.ok(visibleWidth(line) <= width);
});
