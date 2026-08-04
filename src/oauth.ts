import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import type { Config } from "./config.js";

/**
 * Minimal single-user OAuth 2.1 provider, just enough for the MCP
 * authorization spec as used by claude.ai custom connectors:
 *  - RFC 9728 protected resource metadata (/.well-known/oauth-protected-resource)
 *  - RFC 8414 authorization server metadata (/.well-known/oauth-authorization-server)
 *  - RFC 7591 dynamic client registration (claude.ai registers itself; the
 *    Client ID / Client Secret fields in the connector dialog stay EMPTY)
 *  - Authorization code flow with mandatory PKCE (S256)
 *
 * "Logging in" means pasting the vault access key (AUTH_TOKEN) into a browser
 * page — there is exactly one user, so a full IdP would be theater.
 */

const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const CODE_TTL_MS = 5 * 60 * 1000;

interface ClientRecord {
  redirect_uris: string[];
  client_name?: string;
  created: string;
}

interface TokenRecord {
  kind: "access" | "refresh";
  clientId: string;
  expiresAt: number;
}

interface StoreShape {
  clients: Record<string, ClientRecord>;
  tokens: Record<string, TokenRecord>; // keyed by sha256(token)
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export class OAuthStore {
  private data: StoreShape = { clients: {}, tokens: {} };
  private readonly file: string;
  // Codes are short-lived; keeping them in memory avoids disk writes on every
  // authorize. A restart mid-handshake just means clicking Connect again.
  private codes = new Map<string, CodeRecord>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "oauth.json");
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, "utf-8")) as StoreShape;
    } catch {
      // fresh store
    }
    this.prune();
  }

  private prune(): void {
    const now = Date.now();
    for (const [hash, rec] of Object.entries(this.data.tokens)) {
      if (rec.expiresAt < now) delete this.data.tokens[hash];
    }
  }

  private save(): void {
    this.prune();
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  registerClient(redirectUris: string[], name?: string): string {
    const clientId = randomToken();
    this.data.clients[clientId] = {
      redirect_uris: redirectUris,
      client_name: name,
      created: new Date().toISOString(),
    };
    this.save();
    return clientId;
  }

  getClient(clientId: string): ClientRecord | undefined {
    return this.data.clients[clientId];
  }

  issueCode(rec: Omit<CodeRecord, "expiresAt">): string {
    const code = randomToken();
    this.codes.set(sha256(code), { ...rec, expiresAt: Date.now() + CODE_TTL_MS });
    return code;
  }

  consumeCode(code: string): CodeRecord | null {
    const key = sha256(code);
    const rec = this.codes.get(key);
    this.codes.delete(key); // single use, success or not
    if (!rec || rec.expiresAt < Date.now()) return null;
    return rec;
  }

  issueTokens(clientId: string): { accessToken: string; refreshToken: string; expiresInSec: number } {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const now = Date.now();
    this.data.tokens[sha256(accessToken)] = { kind: "access", clientId, expiresAt: now + ACCESS_TOKEN_TTL_MS };
    this.data.tokens[sha256(refreshToken)] = { kind: "refresh", clientId, expiresAt: now + REFRESH_TOKEN_TTL_MS };
    this.save();
    return { accessToken, refreshToken, expiresInSec: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) };
  }

  consumeRefreshToken(token: string): string | null {
    const key = sha256(token);
    const rec = this.data.tokens[key];
    if (!rec || rec.kind !== "refresh" || rec.expiresAt < Date.now()) return null;
    delete this.data.tokens[key]; // rotate
    this.save();
    return rec.clientId;
  }

  isValidAccessToken(token: string): boolean {
    const rec = this.data.tokens[sha256(token)];
    return !!rec && rec.kind === "access" && rec.expiresAt > Date.now();
  }
}

function redirectUriAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === "https:") {
    const h = u.hostname;
    return h === "claude.ai" || h === "claude.com" || h.endsWith(".claude.ai") || h.endsWith(".claude.com");
  }
  if (u.protocol === "http:") {
    // Loopback redirects for local bridges like mcp-remote.
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  }
  return false;
}

function baseUrl(config: Config, req: Request): string {
  if (config.publicUrl) return config.publicUrl;
  const host = req.headers.host ?? `localhost:${config.port}`;
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto =
    typeof forwardedProto === "string"
      ? forwardedProto.split(",")[0].trim()
      : /^(localhost|127\.0\.0\.1)(:|$)/.test(host)
        ? "http"
        : "https";
  return `${proto}://${host}`;
}

function timingSafeEq(a: string, b: string): boolean {
  return crypto.timingSafeEqual(
    crypto.createHash("sha256").update(a).digest(),
    crypto.createHash("sha256").update(b).digest()
  );
}

// Brute-force guard on the authorize password: 5 failures / 15 min per IP.
const failures = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string): boolean {
  const rec = failures.get(ip);
  if (!rec || rec.resetAt < Date.now()) return false;
  return rec.count >= 5;
}
function recordFailure(ip: string): void {
  const rec = failures.get(ip);
  if (!rec || rec.resetAt < Date.now()) {
    failures.set(ip, { count: 1, resetAt: Date.now() + 15 * 60 * 1000 });
  } else {
    rec.count += 1;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function authorizePage(params: Record<string, string>, error?: string): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n      ");
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>clanked-obsidian — authorize</title>
<style>
  body{font-family:system-ui,sans-serif;background:#1e1e2e;color:#cdd6f4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#313244;border-radius:12px;padding:2rem;max-width:24rem;width:90%}
  h1{font-size:1.1rem;margin:0 0 .5rem}
  p{font-size:.9rem;color:#a6adc8;margin:.25rem 0 1rem}
  input[type=password]{width:100%;box-sizing:border-box;padding:.6rem;border-radius:8px;border:1px solid #45475a;background:#1e1e2e;color:#cdd6f4;font-size:1rem}
  button{margin-top:1rem;width:100%;padding:.6rem;border:0;border-radius:8px;background:#89b4fa;color:#1e1e2e;font-size:1rem;font-weight:600;cursor:pointer}
  .err{color:#f38ba8;font-size:.85rem;margin-top:.5rem}
</style></head><body>
  <div class="card">
    <h1>🗄️ clanked-obsidian</h1>
    <p>A client is requesting access to your Obsidian vault. Paste your vault access key (the <code>AUTH_TOKEN</code> from the server's <code>.env</code>) to approve.</p>
    <form method="post" action="">
      ${hidden}
      <input type="password" name="vault_key" placeholder="Vault access key" autofocus autocomplete="off">
      ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
      <button type="submit">Approve access</button>
    </form>
  </div>
</body></html>`;
}

export function registerOAuthRoutes(app: Express, config: Config, store: OAuthStore): void {
  const asMetadata = (req: Request, res: Response): void => {
    const base = baseUrl(config, req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["vault"],
    });
  };
  const prMetadata = (req: Request, res: Response): void => {
    const base = baseUrl(config, req);
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      scopes_supported: ["vault"],
    });
  };
  // RFC 8414 / RFC 9728 well-known paths, with and without the /mcp suffix
  // (clients may append the resource path to the well-known prefix).
  app.get("/.well-known/oauth-authorization-server", asMetadata);
  app.get("/.well-known/oauth-authorization-server/mcp", asMetadata);
  app.get("/.well-known/oauth-protected-resource", prMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", prMetadata);

  app.post("/oauth/register", (req, res) => {
    const body = req.body as { redirect_uris?: unknown; client_name?: unknown };
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (uris.length === 0 || !uris.every(redirectUriAllowed)) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be claude.ai/claude.com HTTPS URLs or loopback HTTP URLs",
      });
      return;
    }
    const clientId = store.registerClient(uris, typeof body.client_name === "string" ? body.client_name : undefined);
    res.status(201).json({
      client_id: clientId,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  const validateAuthorizeParams = (
    q: Record<string, string>
  ): { error: string } | { client: ClientRecord } => {
    const client = q.client_id ? store.getClient(q.client_id) : undefined;
    if (!client) return { error: "Unknown client_id. In claude.ai, leave Client ID/Secret empty so the connector registers itself." };
    if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) return { error: "redirect_uri does not match the registered client." };
    if (q.response_type !== "code") return { error: "response_type must be 'code'." };
    if (!q.code_challenge || q.code_challenge_method !== "S256") return { error: "PKCE with S256 is required." };
    return { client };
  };

  const pickParams = (src: Record<string, unknown>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const k of ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope", "resource"]) {
      const v = src[k];
      if (typeof v === "string") out[k] = v;
    }
    return out;
  };

  app.get("/oauth/authorize", (req, res) => {
    const q = pickParams(req.query as Record<string, unknown>);
    const check = validateAuthorizeParams(q);
    if ("error" in check) {
      res.status(400).send(`<p>${escapeHtml(check.error)}</p>`);
      return;
    }
    res.send(authorizePage(q));
  });

  app.post("/oauth/authorize", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const q = pickParams(body);
    const check = validateAuthorizeParams(q);
    if ("error" in check) {
      res.status(400).send(`<p>${escapeHtml(check.error)}</p>`);
      return;
    }
    const ip = req.ip ?? "unknown";
    if (rateLimited(ip)) {
      res.status(429).send(authorizePage(q, "Too many attempts. Try again in 15 minutes."));
      return;
    }
    const key = typeof body.vault_key === "string" ? body.vault_key.trim() : "";
    if (!key || !config.authToken || !timingSafeEq(key, config.authToken)) {
      recordFailure(ip);
      res.status(401).send(authorizePage(q, "Wrong access key."));
      return;
    }
    const code = store.issueCode({ clientId: q.client_id, redirectUri: q.redirect_uri, challenge: q.code_challenge });
    const target = new URL(q.redirect_uri);
    target.searchParams.set("code", code);
    if (q.state) target.searchParams.set("state", q.state);
    res.redirect(302, target.toString());
  });

  app.post("/oauth/token", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      const code = typeof body.code === "string" ? body.code : "";
      const verifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
      const rec = code ? store.consumeCode(code) : null;
      if (!rec) {
        res.status(400).json({ error: "invalid_grant", error_description: "unknown or expired code" });
        return;
      }
      if (typeof body.client_id === "string" && body.client_id !== rec.clientId) {
        res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });
        return;
      }
      if (typeof body.redirect_uri === "string" && body.redirect_uri !== rec.redirectUri) {
        res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
        return;
      }
      const computed = crypto.createHash("sha256").update(verifier).digest("base64url");
      if (!verifier || computed !== rec.challenge) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
      const t = store.issueTokens(rec.clientId);
      res.json({
        access_token: t.accessToken,
        token_type: "Bearer",
        expires_in: t.expiresInSec,
        refresh_token: t.refreshToken,
        scope: "vault",
      });
      return;
    }

    if (grantType === "refresh_token") {
      const token = typeof body.refresh_token === "string" ? body.refresh_token : "";
      const clientId = token ? store.consumeRefreshToken(token) : null;
      if (!clientId) {
        res.status(400).json({ error: "invalid_grant", error_description: "unknown or expired refresh token" });
        return;
      }
      const t = store.issueTokens(clientId);
      res.json({
        access_token: t.accessToken,
        token_type: "Bearer",
        expires_in: t.expiresInSec,
        refresh_token: t.refreshToken,
        scope: "vault",
      });
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });
}
