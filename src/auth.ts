import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { OAuthStore } from "./oauth.js";

function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Bearer auth for /mcp. Accepts either:
 *   - the static AUTH_TOKEN (Claude Code, Desktop, mcp-remote — via
 *     `Authorization: Bearer <token>` or `x-api-key: <token>`), or
 *   - an OAuth access token issued by our /oauth endpoints (claude.ai
 *     custom connectors, which can only do OAuth on Pro/Max plans).
 *
 * A 401 advertises the protected-resource metadata so OAuth-capable clients
 * know where to start the flow (RFC 9728).
 */
export function bearerAuth(token: string, oauthStore: OAuthStore | null) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    const apiKey = req.headers["x-api-key"];
    let presented: string | null = null;
    if (typeof header === "string" && header.startsWith("Bearer ")) {
      presented = header.slice("Bearer ".length).trim();
    } else if (typeof apiKey === "string") {
      presented = apiKey.trim();
    }
    if (presented) {
      if (timingSafeEqual(presented, token)) {
        next();
        return;
      }
      if (oauthStore?.isValidAccessToken(presented)) {
        next();
        return;
      }
    }
    if (oauthStore) {
      const host = req.headers.host ?? "";
      res.setHeader(
        "WWW-Authenticate",
        `Bearer realm="clanked-obsidian", resource_metadata="https://${host}/.well-known/oauth-protected-resource"`
      );
    }
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
  };
}
