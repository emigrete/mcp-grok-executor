import type { GrokRunOptions, GrokRunResult } from "./grokRunner.js";

/** A way to execute one Grok run. "cli" spawns `grok -p …`; "acp" (future)
 *  speaks the Agent Client Protocol over `grok agent stdio`. */
export type GrokTransport = {
  name: string;
  run(opts: GrokRunOptions): Promise<GrokRunResult>;
};
