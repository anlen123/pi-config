import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Show the classic Pi welcome text on every interactive startup. */
export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setWidget("pi-welcome", (_tui, theme) => ({
      render: (width) => new Text(
        theme.fg("accent", theme.bold("Welcome to pi, the minimal coding agent.")),
        0,
        0,
      ).render(width),
      invalidate: () => {},
    }), { placement: "aboveEditor" });
  });
}
