import path from "node:path";

export interface Config {
  vaultPath: string;
  transport: "http" | "stdio";
  port: number;
  bindHost: string;
  authToken: string | null;
  readOnly: boolean;
  allowDelete: boolean;
  maxReadBytes: number;
  maxSearchResults: number;
  excludeDirs: string[];
  dailyNotesFolder: string | null;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${v}"`);
  }
  return n;
}

export function loadConfig(): Config {
  const vaultPath = process.env.VAULT_PATH;
  if (!vaultPath) {
    throw new Error("VAULT_PATH is required (absolute path to your Obsidian vault)");
  }

  const transport = (process.env.MCP_TRANSPORT ?? "http").toLowerCase();
  if (transport !== "http" && transport !== "stdio") {
    throw new Error(`MCP_TRANSPORT must be "http" or "stdio", got "${transport}"`);
  }

  const authToken = process.env.AUTH_TOKEN?.trim() || null;
  if (transport === "http" && !authToken) {
    throw new Error(
      "AUTH_TOKEN is required in http mode. Generate one with: openssl rand -hex 32"
    );
  }
  if (authToken && authToken.length < 16) {
    throw new Error("AUTH_TOKEN must be at least 16 characters");
  }

  const excludeDirs = (process.env.EXCLUDE_DIRS ?? ".obsidian,.trash,.git")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);

  return {
    vaultPath: path.resolve(vaultPath),
    transport,
    port: envInt("PORT", 8484),
    // Default to loopback: tailscale serve/funnel proxies from localhost, so
    // the server is never directly reachable on any real interface.
    bindHost: process.env.BIND_HOST ?? "127.0.0.1",
    authToken,
    readOnly: envBool("READ_ONLY", false),
    allowDelete: envBool("ALLOW_DELETE", false),
    maxReadBytes: envInt("MAX_READ_BYTES", 1_000_000),
    maxSearchResults: envInt("MAX_SEARCH_RESULTS", 100),
    excludeDirs,
    dailyNotesFolder: process.env.DAILY_NOTES_FOLDER?.trim() || null,
  };
}
