import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { Vault, VaultError } from "./vault.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function wrap(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  return fn().catch((err: unknown) => {
    const message = err instanceof VaultError ? err.message : `Internal error: ${String(err)}`;
    return { content: [{ type: "text" as const, text: message }], isError: true };
  });
}

export function buildServer(config: Config): McpServer {
  const vault = new Vault(config);
  const server = new McpServer({
    name: "clanked-obsidian",
    version: "0.1.0",
  });

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description:
        "List notes in the Obsidian vault, most recently modified first. " +
        "Optionally scope to a folder (vault-relative path).",
      inputSchema: {
        folder: z.string().optional().describe("Vault-relative folder to list, e.g. 'Projects'"),
        limit: z.number().int().positive().max(500).optional().describe("Max notes to return (default 100)"),
      },
    },
    async ({ folder, limit }) =>
      wrap(async () => {
        const notes = await vault.listNotes(folder);
        const shown = notes.slice(0, limit ?? 100);
        const lines = shown.map((n) => `${n.path}  (${n.size} bytes, modified ${n.modified})`);
        const suffix = notes.length > shown.length ? `\n… and ${notes.length - shown.length} more` : "";
        return ok(lines.length ? lines.join("\n") + suffix : "No notes found.");
      })
  );

  server.registerTool(
    "list_folders",
    {
      title: "List folders",
      description: "List all folders in the vault.",
      inputSchema: {},
    },
    async () =>
      wrap(async () => {
        const folders = await vault.listFolders();
        return ok(folders.length ? folders.join("\n") : "No folders (flat vault).");
      })
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description: "Read the full content of a note. Path is relative to the vault root, e.g. 'Projects/ideas.md'.",
      inputSchema: {
        path: z.string().describe("Vault-relative path of the note"),
      },
    },
    async ({ path: notePath }) => wrap(async () => ok(await vault.readNote(notePath)))
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Case-insensitive full-text and filename search across the vault. " +
        "Returns matching lines as 'path:line: text'.",
      inputSchema: {
        query: z.string().min(2).describe("Text to search for"),
        folder: z.string().optional().describe("Restrict search to this vault-relative folder"),
      },
    },
    async ({ query, folder }) =>
      wrap(async () => {
        const matches = await vault.searchNotes(query, folder);
        if (matches.length === 0) return ok(`No matches for "${query}".`);
        const lines = matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
        const capped =
          matches.length >= config.maxSearchResults
            ? `\n(results capped at ${config.maxSearchResults})`
            : "";
        return ok(lines.join("\n") + capped);
      })
  );

  server.registerTool(
    "daily_note",
    {
      title: "Read daily note",
      description:
        "Read the daily note for a given date (default: today, UTC). " +
        "Uses the YYYY-MM-DD.md convention inside DAILY_NOTES_FOLDER.",
      inputSchema: {
        date: z.string().optional().describe("Date as YYYY-MM-DD (default today)"),
      },
    },
    async ({ date }) =>
      wrap(async () => {
        const notePath = vault.dailyNotePath(date);
        try {
          return ok(await vault.readNote(notePath));
        } catch (err) {
          if (err instanceof VaultError) {
            return ok(`No daily note at ${notePath} yet.`);
          }
          throw err;
        }
      })
  );

  if (!config.readOnly) {
    server.registerTool(
      "write_note",
      {
        title: "Write note",
        description:
          "Create a new markdown note (or overwrite an existing one if overwrite=true). " +
          "Parent folders are created automatically.",
        inputSchema: {
          path: z.string().describe("Vault-relative path ending in .md"),
          content: z.string().describe("Full markdown content of the note"),
          overwrite: z.boolean().optional().describe("Replace the note if it already exists (default false)"),
        },
      },
      async ({ path: notePath, content, overwrite }) =>
        wrap(async () => {
          const written = await vault.writeNote(notePath, content, overwrite ?? false);
          return ok(`Wrote ${written}`);
        })
    );

    server.registerTool(
      "append_note",
      {
        title: "Append to note",
        description: "Append markdown to a note, creating it if it does not exist. Good for logs and daily notes.",
        inputSchema: {
          path: z.string().describe("Vault-relative path ending in .md"),
          content: z.string().describe("Markdown to append"),
        },
      },
      async ({ path: notePath, content }) =>
        wrap(async () => {
          const written = await vault.appendNote(notePath, content);
          return ok(`Appended to ${written}`);
        })
    );

    if (config.allowDelete) {
      server.registerTool(
        "delete_note",
        {
          title: "Delete note",
          description: "Permanently delete a note from the vault. There is no trash — this cannot be undone.",
          inputSchema: {
            path: z.string().describe("Vault-relative path of the note to delete"),
          },
        },
        async ({ path: notePath }) =>
          wrap(async () => {
            await vault.deleteNote(notePath);
            return ok(`Deleted ${notePath}`);
          })
      );
    }
  }

  return server;
}
