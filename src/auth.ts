import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Bearer-token middleware. Accepts the token via either:
 *   Authorization: Bearer <token>   (claude.ai custom connector header, Claude Code)
 *   x-api-key: <token>              (fallback for clients that can't set Authorization)
 */
export function bearerAuth(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    const apiKey = req.headers["x-api-key"];
    let presented: string | null = null;
    if (typeof header === "string" && header.startsWith("Bearer ")) {
      presented = header.slice("Bearer ".length).trim();
    } else if (typeof apiKey === "string") {
      presented = apiKey.trim();
    }
    if (presented && timingSafeEqual(presented, token)) {
      next();
      return;
    }
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
  };
}
