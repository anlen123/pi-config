/**
 * UI 去重扩展 - 消除 @hhyy668/pi-desktop-ui 与 pi-powerline-footer 的重复渲染
 *
 * 背景：
 * pi-powerline-footer 通过 widget 行渲染模型/思考级别/目录/缓存统计，
 * 而 @hhyy668/pi-desktop-ui 在 session_start 时还会无条件渲染三处终端 UI：
 *   1. setFooter(...)              —— 底部状态栏（项目名/分支/模型/In/Out/Cache/$）
 *   2. setWidget("desktop-context")—— 编辑器上方横幅（◈ 项目名 / 分支）
 *   3. setStatus("desktop", "◈ Desktop") —— 状态栏状态
 * 导致模型名、项目名、缓存统计等同一信息在屏幕上下重复出现。
 *
 * 本扩展在每次 session_start 后清理 desktop-ui 的 footer 和 widget：
 * - footer 恢复为空（与 powerline 的空 footer 一致），避免与 powerline 行重复
 * - 移除 desktop-context widget，保留 setStatus 的 "◈ Desktop" 作为唯一桌面指示
 *
 * 为什么用 setTimeout：
 * 本地扩展（~/.pi/agent/extensions）先于 npm 包加载，session_start 处理器
 * 也先执行；desktop-ui 的渲染发生在本地处理器之后。延迟清理确保覆盖
 * desktop-ui 的渲染结果。setWidget(key, undefined) 对不存在的 key 是幂等
 * no-op，重复触发安全。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DESKTOP_WIDGET_KEY = "desktop-context";
// 首次在事件循环尾部立即清理（desktop-ui 的 session_start 同步注册已完成），
// 500ms 再兑底一次，覆盖任何更晚的重新注册。
const CLEANUP_DELAYS_MS = [0, 500];

export default function (pi: ExtensionAPI) {
	function cleanupDesktopUiOverlap(ctx: ExtensionContext) {
		try {
			// 移除 desktop-ui 的编辑器上方横幅（与 "◈ Desktop" 状态重复）
			ctx.ui.setWidget(DESKTOP_WIDGET_KEY, undefined);
			// 覆盖 desktop-ui 的底部 footer（与 powerline 行重复模型/项目/缓存），
			// 恢复为空 footer（与 powerline 默认一致）
			ctx.ui.setFooter(() => ({
				invalidate() {},
				render() {
					return [""];
				},
			}));
		} catch {
			// 上下文可能已随会话切换失效，忽略
		}
	}

	pi.on("session_start", (_event, ctx) => {
		// desktop-ui 的 session_start 处理器在其加载完成后同步渲染，
		// 延迟到事件循环尾部清理，确保覆盖其输出（setWidget 对不存在的
		// key 幂等 no-op，重复触发安全）。
		for (const delay of CLEANUP_DELAYS_MS) {
			setTimeout(() => cleanupDesktopUiOverlap(ctx), delay);
		}
	});
}
