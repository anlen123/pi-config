/**
 * MCP (Model Context Protocol) client extension for pi.
 *
 * Connects to configured MCP servers, discovers their tools, and registers
 * them as pi tools callable by the LLM.
 *
 * Configuration: Edit MCP_SERVERS below to add/remove servers.
 * Server config format matches Claude Code's .claude.json mcpServers format.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── MCP Server Configuration ───────────────────────────────────────────────
// Migrated from ~/.claude.json → mcpServers
// Migrated from ~/.codex/config.toml → [mcp_servers]

interface McpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

const MCP_SERVERS: Record<string, McpServerConfig> = {
  // Add MCP servers here. See McpServerConfig interface for options.
};

// ─── MCP Client Helpers ─────────────────────────────────────────────────────

async function mcpRequest(
  url: string,
  headers: Record<string, string>,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const body: Record<string, unknown> = {
    jsonrpc: "2.0",
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    method,
  };
  if (params !== undefined) {
    body.params = params;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  // Handle SSE / non-JSON responses gracefully (some servers use SSE)
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("json")) {
    const text = await res.text();
    // Try to parse SSE-like responses
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      if (data.error) throw new Error(`MCP error: ${data.error.message}`);
      return data.result;
    }
    throw new Error(
      `MCP unexpected response (${res.status}): ${text.slice(0, 200)}`,
    );
  }

  const data: Record<string, unknown> = await res.json();
  if (data.error) {
    const err = data.error as Record<string, unknown>;
    throw new Error(`MCP error: ${err.message || JSON.stringify(err)}`);
  }
  return data.result;
}

async function mcpNotify(
  url: string,
  headers: Record<string, string>,
  method: string,
  params?: Record<string, unknown>,
): Promise<void> {
  // Notification: no id field
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) body.params = params;

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  // Ignore response for notifications
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    for (const [serverName, config] of Object.entries(MCP_SERVERS)) {
      try {
        ctx.ui.setStatus(`mcp:${serverName}`, `MCP: connecting to ${serverName}…`);

        // Step 1: Initialize
        const initResult = (await mcpRequest(
          config.url,
          config.headers || {},
          "initialize",
          {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "pi", version: "1.0.0" },
          },
        )) as Record<string, unknown> | undefined;

        // Step 2: Send "initialized" notification
        await mcpNotify(config.url, config.headers || {}, "notifications/initialized");

        const serverInfo = initResult?.serverInfo as Record<string, unknown> | undefined;
        ctx.ui.setStatus(
          `mcp:${serverName}`,
          `MCP: ${serverInfo?.name || serverName} ✓`,
        );
        ctx.ui.notify(
          `MCP ${serverName}: connected to ${serverInfo?.name || serverName} v${serverInfo?.version || "?"}`,
          "info",
        );

        // Step 3: List tools
        const toolsResult = (await mcpRequest(
          config.url,
          config.headers || {},
          "tools/list",
        )) as Record<string, unknown> | undefined;
        const tools = (toolsResult?.tools || []) as Array<Record<string, unknown>>;

        if (tools.length === 0) {
          ctx.ui.notify(`MCP ${serverName}: no tools available`, "info");
          continue;
        }

        // Step 4: Register each tool
        for (const tool of tools) {
          const toolName = tool.name as string;
          const toolDescription = (tool.description as string) || toolName;
          const piToolName = `mcp__${serverName}__${toolName}`;

          pi.registerTool({
            name: piToolName,
            label: `${serverName}/${toolName}`,
            description: `[MCP:${serverName}] ${toolDescription}`,
            promptSnippet: `${toolDescription}`,
            // Accept any object — the MCP server does its own validation
            parameters: Type.Object(
              {},
              { additionalProperties: true },
            ) as unknown as Parameters<typeof pi.registerTool>[0]["parameters"],
            async execute(_toolCallId, params) {
              const result = (await mcpRequest(
                config.url,
                config.headers || {},
                "tools/call",
                {
                  name: toolName,
                  arguments: params as Record<string, unknown>,
                },
              )) as Record<string, unknown> | undefined;

              // Convert MCP content to text
              const contents = (result?.content || []) as Array<Record<string, unknown>>;
              const textParts: string[] = [];

              for (const item of contents) {
                switch (item.type) {
                  case "text":
                    textParts.push(item.text as string);
                    break;
                  case "image":
                    textParts.push(
                      `[Image: ${item.mimeType || "unknown"}]`,
                    );
                    break;
                  case "resource":
                    textParts.push(
                      `[Resource: ${(item.resource as Record<string, unknown>)?.uri || "unknown"}]`,
                    );
                    break;
                  default:
                    textParts.push(JSON.stringify(item));
                }
              }

              // Check if result is an error
              if (result?.isError) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `MCP tool error: ${textParts.join("\n") || JSON.stringify(result)}`,
                    },
                  ],
                  details: { isError: true },
                };
              }

              return {
                content: [
                  {
                    type: "text",
                    text: textParts.join("\n") || JSON.stringify(result),
                  },
                ],
                details: {},
              };
            },
          });
        }

        ctx.ui.notify(
          `MCP ${serverName}: registered ${tools.length} tool(s)`,
          "info",
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.setStatus(`mcp:${serverName}`, `MCP: ${serverName} ✗`);
        ctx.ui.notify(`MCP ${serverName} error: ${message}`, "error");
      }
    }
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    // Clean up status
    for (const serverName of Object.keys(MCP_SERVERS)) {
      // Status will be cleared when session ends
    }
  });
}
