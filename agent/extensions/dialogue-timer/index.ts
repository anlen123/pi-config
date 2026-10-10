import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatElapsed } from "./timer.ts";

export const STATUS_KEY = "dialogue-timer";

/** Independent footer status; does not replace the footer or make network requests. */
export default function dialogueTimer(pi: ExtensionAPI, now: () => number = () => performance.now()) {
	let running: { sessionId: string; startedAt: number } | undefined;

	function hasTerminal(ctx: ExtensionContext) {
		return ctx.hasUI && ctx.mode === "tui";
	}

	function clear(ctx: ExtensionContext) {
		running = undefined;
		if (hasTerminal(ctx)) ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	pi.on("session_start", (_event, ctx) => clear(ctx));
	pi.on("session_shutdown", (_event, ctx) => clear(ctx));

	pi.on("agent_start", (_event, ctx) => {
		if (!hasTerminal(ctx)) return;
		const sessionId = ctx.sessionManager.getSessionId();
		// A retry or automatic continuation can start another low-level loop.
		// Keep the first timestamp until the entire dialogue truly settles.
		if (!running || running.sessionId !== sessionId) {
			running = { sessionId, startedAt: now() };
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!hasTerminal(ctx) || !running || running.sessionId !== ctx.sessionManager.getSessionId()) return;
		const elapsed = now() - running.startedAt;
		running = undefined;
		// Keep the most recently completed dialogue visible during the next run.
		// Plain text lets the built-in footer apply the current theme each render.
		ctx.ui.setStatus(STATUS_KEY, `本次耗时 ${formatElapsed(elapsed)}`);
	});
}
