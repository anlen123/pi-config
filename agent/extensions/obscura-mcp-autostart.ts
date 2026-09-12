/**
 * Obscura MCP 自动启动 / 守护
 *
 * 作用：pi 会话启动时，确保本地 Obscura 无头浏览器的 MCP HTTP 服务
 *       http://127.0.0.1:8080/mcp 处于运行状态（`mcp.json` 里的 `local-mcp` 指向它）。
 *
 * 策略（按顺序）：
 *   1. 探测 8080 是否已有健康的 obscura MCP 服务 → 有就直接复用，什么都不做
 *   2. 没有 → 尝试 `systemctl --user start obscura-mcp`（本机已装好该 unit）
 *   3. systemd 不可用或启动失败 → 自己 detached spawn 一个，日志写到 /var/log/obscura-mcp.log
 *
 * 生命周期：默认 **不在退出时停掉**服务 —— 它是个 ~16MB 的守护进程，多个 pi 会话
 *          共用同一个实例，杀掉会让别的会话工具失效。想严格随 pi 退出就设
 *          OBSCURA_MCP_AUTOSTOP=1（只会停掉"本会话亲手拉起"的那个）。
 *
 * 环境变量：
 *   OBSCURA_BIN            二进制路径        默认 /opt/obscura/obscura
 *   OBSCURA_MCP_SERVICE    systemd unit 名   默认 obscura-mcp
 *   OBSCURA_MCP_PORT       端口              默认 8080
 *   OBSCURA_MCP_AUTOSTOP   1 = 退出时停掉本会话拉起的实例
 *
 * 命令：/obscura-mcp [status|start|stop|restart|logs]
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.OBSCURA_MCP_PORT ?? 8080);
const BIN = process.env.OBSCURA_BIN ?? "/opt/obscura/obscura";
const SERVICE = process.env.OBSCURA_MCP_SERVICE ?? "obscura-mcp";
const LOG_FILE = "/var/log/obscura-mcp.log";
// 兜底 spawn 时的日志级别，与 /etc/obscura-mcp.env 里的默认保持一致（off = 不打日志）
const LOG_LEVEL = process.env.RUST_LOG ?? "off";
const STATUS_KEY = "obscura-mcp";
const ENDPOINT = `http://${HOST}:${PORT}/mcp`;

type State = "running" | "started-by-systemd" | "started-by-spawn" | "failed";

let startedByThisSession = false;

/** 发一个最小的 JSON-RPC 请求，确认端口后面确实是 obscura 的 MCP 服务 */
async function probe(timeoutMs = 1500): Promise<boolean> {
	const signal = AbortSignal.timeout(timeoutMs);
	try {
		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			signal,
		});
		if (!res.ok) return false;
		const text = await res.text();
		return text.includes("browser_navigate");
	} catch {
		return false;
	}
}

async function waitUntilUp(totalMs = 12000): Promise<boolean> {
	const deadline = Date.now() + totalMs;
	while (Date.now() < deadline) {
		if (await probe(1200)) return true;
		await new Promise((r) => setTimeout(r, 400));
	}
	return false;
}

async function trySystemdStart(pi: ExtensionAPI): Promise<boolean> {
	if (!process.env.XDG_RUNTIME_DIR) return false;
	const result = await pi.exec("systemctl", ["--user", "start", SERVICE], { timeout: 15000 });
	return result.code === 0;
}

function spawnDetached(): boolean {
	try {
		const log = openSync(LOG_FILE, "a");
		const child = spawn(
			BIN,
			["mcp", "--http", "--host", HOST, "--port", String(PORT)],
			{
				detached: true,
				stdio: ["ignore", log, log],
				env: { ...process.env, RUST_LOG: LOG_LEVEL },
			},
		);
		child.unref();
		return true;
	} catch {
		return false;
	}
}

async function ensure(pi: ExtensionAPI): Promise<State> {
	if (await probe()) return "running";

	if (await trySystemdStart(pi)) {
		if (await waitUntilUp()) {
			startedByThisSession = true;
			return "started-by-systemd";
		}
	}

	if (spawnDetached() && (await waitUntilUp())) {
		startedByThisSession = true;
		return "started-by-spawn";
	}
	return "failed";
}

function renderStatus(ctx: ExtensionContext, state: State): void {
	const theme = ctx.ui.theme;
	const up = state === "running" || state === "started-by-systemd" || state === "started-by-spawn";
	if (up) {
		ctx.ui.setStatus(STATUS_KEY, theme.fg("success", "obscura ●"));
	} else {
		ctx.ui.setStatus(STATUS_KEY, theme.fg("error", "obscura ✗"));
	}
}

const STATE_TEXT: Record<State, string> = {
	running: "已在运行（复用现有实例）",
	"started-by-systemd": "已由 systemd 拉起",
	"started-by-spawn": "已由扩展直接拉起",
	failed: "启动失败",
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const state = await ensure(pi);
		renderStatus(ctx, state);

		if (state === "started-by-systemd" || state === "started-by-spawn") {
			ctx.ui.notify(`Obscura MCP: ${STATE_TEXT[state]} → ${HOST}:${PORT}`, "info");
		} else if (state === "failed") {
			ctx.ui.notify(
				`Obscura MCP 启动失败，请检查 ${BIN} 或 systemctl --user status ${SERVICE}`,
				"error",
			);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (process.env.OBSCURA_MCP_AUTOSTOP === "1" && startedByThisSession) {
			await pi.exec("systemctl", ["--user", "stop", SERVICE], { timeout: 15000 });
		}
	});

	pi.registerCommand("obscura-mcp", {
		description: "管理 Obscura MCP 服务（status / start / stop / restart / logs）",
		handler: async (args, ctx) => {
			const action = (args || "status").trim().split(/\s+/)[0];

			if (action === "status") {
				const up = await probe();
				const unit = await pi.exec("systemctl", ["--user", "is-active", SERVICE], { timeout: 8000 });
				ctx.ui.notify(
					`obscura MCP: ${up ? "运行中" : "未运行"} @ ${HOST}:${PORT}｜unit ${SERVICE}: ${unit.stdout.trim() || "unknown"}`,
					up ? "info" : "warning",
				);
				return;
			}

			if (action === "logs") {
				const logs = await pi.exec("journalctl", ["--user", "-u", SERVICE, "-n", "20", "--no-pager"], {
					timeout: 10000,
				});
				ctx.ui.setWidget("obscura-mcp-logs", (logs.stdout || "(无日志)").split("\n"), { placement: "aboveEditor" });
				return;
			}

			if (action === "stop") {
				await pi.exec("systemctl", ["--user", "stop", SERVICE], { timeout: 15000 });
				ctx.ui.notify("obscura MCP 已停止", "info");
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "obscura ✗"));
				return;
			}

			if (action === "restart") {
				await pi.exec("systemctl", ["--user", "restart", SERVICE], { timeout: 20000 });
			}

			// start / restart 共用的启动 + 校验
			const state = await ensure(pi);
			renderStatus(ctx, state);
			ctx.ui.notify(`obscura MCP: ${STATE_TEXT[state]}`, state === "failed" ? "error" : "info");
		},
	});
}
