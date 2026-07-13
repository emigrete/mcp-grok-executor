#!/usr/bin/env node
/**
 * mcp-grok-executor
 *
 * Claude Code (Fable) = advisor/orchestrator
 * Grok Build CLI     = execution agent (subscription login via `grok login`)
 *
 * Transport: MCP stdio
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { ensureCacheDir } from "./jobs.js";
import { checkGrokAuth } from "./auth.js";

async function main(): Promise<void> {
  await ensureCacheDir();

  const auth = await checkGrokAuth();
  if (!auth.ok) {
    console.error(`[mcp-grok-executor] WARNING: ${auth.message}`);
  } else {
    console.error(`[mcp-grok-executor] ${auth.message}`);
  }

  const server = new McpServer({
    name: "mcp-grok-executor",
    version: "0.2.0",
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-grok-executor] listening on stdio");
}

main().catch((err) => {
  console.error("[mcp-grok-executor] fatal:", err);
  process.exit(1);
});
