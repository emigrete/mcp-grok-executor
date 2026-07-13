import { homedir } from "node:os";
import { join } from "node:path";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  /** Path to the `grok` binary */
  grokBin: process.env.GROK_BIN?.trim() || "grok",

  /** Grok auth file (subscription login) */
  authPath: process.env.GROK_AUTH_PATH?.trim() || join(homedir(), ".grok", "auth.json"),

  /** Cache/logs for job output */
  cacheDir:
    process.env.MCP_GROK_CACHE_DIR?.trim() ||
    join(homedir(), ".cache", "mcp-grok-executor"),

  /** Default timeout for synchronous Grok runs (seconds) */
  defaultTimeoutSec: envInt("MCP_GROK_TIMEOUT_SEC", 600),

  /** Max characters returned inline to the MCP client */
  maxOutputChars: envInt("MCP_GROK_MAX_OUTPUT_CHARS", 80_000),

  /** Optional default model for Grok */
  defaultModel: process.env.MCP_GROK_MODEL?.trim() || undefined,

  /** Read-only tool allowlist for review_task */
  reviewTools:
    process.env.MCP_GROK_REVIEW_TOOLS?.trim() ||
    "read_file,grep,list_dir,web_search,web_fetch,open_page,open_page_with_find",

  /** Mutating tools to strip even if review allowlist is bypassed */
  reviewDisallowedTools:
    process.env.MCP_GROK_REVIEW_DISALLOWED?.trim() ||
    "search_replace,write,run_terminal_cmd,run_terminal_command,image_gen,image_edit,image_to_video",

  /** Transport for grok runs: "cli" (default) or "acp" (experimental) */
  transport: process.env.MCP_GROK_TRANSPORT?.trim() || "cli",
} as const;
