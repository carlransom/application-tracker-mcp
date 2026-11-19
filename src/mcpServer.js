import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { STATUSES } from "./config.js";

// READ-ONLY tools. There are no write, update, or delete tools here, by
// design — the server can only read the calling user's own applications.
// Every tool is bound to the uid from the verified OAuth access token.

const StatusEnum = z.enum(STATUSES);

const ApplicationSchema = z.object({
  id: z.string(),
  company: z.string(),
  role: z.string(),
  location: z.string(),
  type: z.string(),
  status: StatusEnum,
  applied: z.string(),
  closing: z.string(),
  pay: z.string(),
  req: z.string(),
  url: z.string(),
  notes: z.string(),
});

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function textResult(text, structuredContent) {
  const out = { content: [{ type: "text", text }] };
  if (structuredContent !== undefined) out.structuredContent = structuredContent;
  return out;
}

export function createMcpServer(uid, store) {
  const server = new McpServer(
    { name: "application-tracker", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "list_applications",
    {
      title: "List applications",
      description:
        "List the user's job applications, newest first. Optionally filter by pipeline status.",
      inputSchema: {
        status: StatusEnum.optional().describe(
          "Only return applications in this pipeline status.",
        ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum applications to return (default 50)."),
      },
      outputSchema: {
        applications: z.array(ApplicationSchema),
        count: z.number(),
      },
      annotations: READ_ONLY,
    },
    async ({ status, limit }) => {
      const applications = await store.listApplications(uid, {
        status,
        limit: limit ?? 50,
      });
      return textResult(JSON.stringify(applications, null, 2), {
        applications,
        count: applications.length,
      });
    },
  );

  server.registerTool(
    "get_application",
    {
      title: "Get application",
      description: "Get one application by its id.",
      inputSchema: {
        id: z.string().describe("The application id."),
      },
      outputSchema: {
        application: ApplicationSchema.nullable(),
      },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const application = await store.getApplication(uid, id);
      if (!application) {
        return {
          content: [
            {
              type: "text",
              text: `No application found with id "${id}".`,
            },
          ],
          isError: true,
        };
      }
      return textResult(JSON.stringify(application, null, 2), { application });
    },
  );

  server.registerTool(
    "search_applications",
    {
      title: "Search applications",
      description:
        "Search the user's applications by text. Matches company, role, location, and notes (case-insensitive).",
      inputSchema: {
        query: z.string().min(1).describe("Text to search for."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum applications to return (default 50)."),
      },
      outputSchema: {
        applications: z.array(ApplicationSchema),
        count: z.number(),
      },
      annotations: READ_ONLY,
    },
    async ({ query, limit }) => {
      const applications = await store.searchApplications(uid, {
        query,
        limit: limit ?? 50,
      });
      return textResult(JSON.stringify(applications, null, 2), {
        applications,
        count: applications.length,
      });
    },
  );

  server.registerTool(
    "get_stats",
    {
      title: "Get application stats",
      description:
        "Summary counts for the user's job search: total applications and counts by pipeline status.",
      inputSchema: {},
      outputSchema: {
        total: z.number(),
        byStatus: z.object(
          Object.fromEntries(STATUSES.map((s) => [s, z.number()])),
        ),
        active: z.number(),
        offers: z.number(),
        interviews: z.number(),
      },
      annotations: READ_ONLY,
    },
    async () => {
      const stats = await store.getStats(uid);
      return textResult(JSON.stringify(stats, null, 2), stats);
    },
  );

  return server;
}
