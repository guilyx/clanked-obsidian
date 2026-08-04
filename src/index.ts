import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { bearerAuth } from "./auth.js";
import { OAuthStore, registerOAuthRoutes } from "./oauth.js";

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.transport === "stdio") {
    const server = buildServer(config);
    await server.connect(new StdioServerTransport());
    console.error(`clanked-obsidian serving vault ${config.vaultPath} on stdio`);
    return;
  }

  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, readOnly: config.readOnly });
  });

  let oauthStore: OAuthStore | null = null;
  if (config.oauthEnabled) {
    oauthStore = new OAuthStore(config.dataDir);
    registerOAuthRoutes(app, config, oauthStore);
  }

  // authToken is guaranteed non-null in http mode by loadConfig.
  app.use("/mcp", bearerAuth(config.authToken!, oauthStore));

  // Stateless mode: a fresh server + transport per request. Slightly more
  // work per call, but no session table to leak and safe behind any proxy.
  app.post("/mcp", async (req, res) => {
    const server = buildServer(config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const reject = (res: express.Response): void => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless server)" },
      id: null,
    });
  };
  app.get("/mcp", (_req, res) => reject(res));
  app.delete("/mcp", (_req, res) => reject(res));

  app.listen(config.port, config.bindHost, () => {
    console.log(
      `clanked-obsidian listening on http://${config.bindHost}:${config.port}/mcp` +
        ` (vault: ${config.vaultPath}, readOnly: ${config.readOnly}, delete: ${config.allowDelete}` +
        `, oauth: ${config.oauthEnabled})`
    );
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
