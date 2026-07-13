import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJob, listJobs, readJobLog } from "./jobs.js";

const JSON_MIME = "application/json";

export function registerResources(server: McpServer): void {
  server.registerResource(
    "recent-jobs",
    "grok://jobs/recent",
    {
      mimeType: JSON_MIME,
      description: "Last 20 grok job records (newest first)",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: JSON_MIME,
          text: JSON.stringify(listJobs().slice(0, 20), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "job",
    new ResourceTemplate("grok://jobs/{id}", { list: undefined }),
    {
      mimeType: JSON_MIME,
      description: "Single grok job record with log tail",
    },
    async (uri, variables) => {
      const id = String(variables.id ?? "");
      const job = getJob(id);
      if (!job) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: JSON_MIME,
              text: JSON.stringify({ error: "unknown job" }, null, 2),
            },
          ],
        };
      }
      const log = await readJobLog(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: JSON_MIME,
            text: JSON.stringify({ job, log }, null, 2),
          },
        ],
      };
    },
  );
}
