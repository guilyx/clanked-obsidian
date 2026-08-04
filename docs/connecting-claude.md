# Connecting Claude to your vault

All three clients talk to the same endpoint: `https://<nuc>.<tailnet>.ts.net/mcp`, authenticated with `Authorization: Bearer <AUTH_TOKEN>`.

Which exposure mode you need:

| Client | Where it runs | Needs |
|---|---|---|
| Claude Code | your laptop (in the tailnet) | `tailscale serve` |
| Claude Desktop | your laptop (in the tailnet) | `tailscale serve` |
| claude.ai web / mobile app | Anthropic's servers | `tailscale funnel` (public) |

## Claude Code

```bash
claude mcp add --transport http obsidian \
  https://<nuc>.<tailnet>.ts.net/mcp \
  --header "Authorization: Bearer <AUTH_TOKEN>"
```

Then in any session: `/mcp` shows the connection, and Claude can call `search_notes`, `read_note`, etc. Add `--scope user` if you want it available in every project.

## Claude Desktop

**Option A — custom connector (no extra software).**
Settings → Connectors → Add custom connector. Paste the URL. If the dialog offers request headers (rolling out as a beta), add `Authorization: Bearer <AUTH_TOKEN>` and you're done.

**Option B — `mcp-remote` bridge.**
If you can't set headers in the dialog, run a tiny local bridge that speaks stdio to Desktop and HTTP (with the header) to the NUC. In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://<nuc>.<tailnet>.ts.net/mcp",
        "--header", "Authorization: Bearer ${OBSIDIAN_MCP_TOKEN}"
      ],
      "env": { "OBSIDIAN_MCP_TOKEN": "<AUTH_TOKEN>" }
    }
  }
}
```

Restart Desktop; the tools appear under the 🔌 icon.

## claude.ai (web) and the mobile app — OAuth

This is the only client that requires `tailscale funnel`, because Anthropic's servers — not your device — make the HTTP calls, and they are not in your tailnet. It's also the only client that requires OAuth: on Pro/Max plans the custom connector dialog has no header field, only optional OAuth Client ID/Secret. The server ships a built-in single-user OAuth provider for exactly this, enabled by default (`OAUTH_ENABLED=true`).

1. On the NUC: `sudo tailscale funnel --bg 8484` (confirm with `tailscale funnel status`).
2. On claude.ai: [Customize → Connectors](https://claude.ai/customize/connectors) → **"+"** → **Add custom connector**.
3. Name: `Obsidian`, URL: `https://<nuc>.<tailnet>.ts.net/mcp`.
4. **Leave Advanced settings empty** — no Client ID, no Client Secret. Claude discovers the server's OAuth endpoints (`/.well-known/...`) and registers itself via dynamic client registration.
5. Click **Add**, then **Connect**. Your browser opens an authorization page served by *your* NUC.
6. Paste your vault access key (the `AUTH_TOKEN` from `/opt/clanked-obsidian/.env` — the install summary printed it) and click **Approve access**.
7. Claude receives a 30-day access token (auto-refreshed with a rotating 90-day refresh token). Enable the connector in a chat via the search-and-tools menu.

Connectors added on the web are available in the mobile apps too.

Under the hood this is the standard MCP authorization flow: RFC 9728 protected-resource metadata discovery → RFC 8414 auth-server metadata → RFC 7591 dynamic registration → authorization code + PKCE (S256). Redirect URIs are allowlisted to `claude.ai`/`claude.com` (plus loopback for local bridges), and the browser approval page is rate-limited against brute force.

To cut claude.ai's access later: delete `data/oauth.json` in the install dir and restart the service (revokes all OAuth grants), or rotate `AUTH_TOKEN` to also cut bearer clients.

## Verifying end to end

From any machine that should have access:

```bash
curl -s https://<nuc>.<tailnet>.ts.net/healthz
# {"ok":true,"readOnly":false}

curl -s https://<nuc>.<tailnet>.ts.net/mcp \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <AUTH_TOKEN>" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

You should see the tool list. Without the header you must get a 401 — if you don't, stop and check your setup.

## Troubleshooting

- **401 Unauthorized** — header typo (`Bearer` prefix missing?) or token mismatch with `.env` on the NUC.
- **Connection refused via ts.net URL** — `tailscale serve status` on the NUC; re-run `sudo tailscale serve --bg 8484`.
- **Works on laptop, not on claude.ai** — you're serving but not funneling. `sudo tailscale funnel --bg 8484`.
- **claude.ai says "Unknown client_id"** — you filled in the OAuth Client ID/Secret fields manually. Remove the connector, re-add it with Advanced settings empty, and let it self-register.
- **claude.ai connect fails immediately** — OAuth is disabled. Set `OAUTH_ENABLED=true` in `.env` and `sudo systemctl restart clanked-obsidian`.
- **"Wrong access key" on the approval page** — paste the exact `AUTH_TOKEN` value from `.env` (no `Bearer` prefix, no quotes).
- **`AUTH_TOKEN is required in http mode`** on startup — set it in `.env` (the server refuses to run unauthenticated HTTP by design).
- **Tools missing in Claude** — `write_note`/`append_note` disappear when `READ_ONLY=true`; `delete_note` only exists when `ALLOW_DELETE=true`.
