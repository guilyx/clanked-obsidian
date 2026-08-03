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

## claude.ai (web) and the mobile app

This is the only client that requires `tailscale funnel`, because Anthropic's servers — not your device — make the HTTP calls, and they are not in your tailnet.

1. On the NUC: `sudo tailscale funnel --bg 8484` (and confirm with `tailscale funnel status`).
2. On claude.ai: Settings → Connectors → **Add custom connector**.
3. Name: `Obsidian`, URL: `https://<nuc>.<tailnet>.ts.net/mcp`.
4. In the connector dialog, add a request header: `Authorization` → `Bearer <AUTH_TOKEN>`. Anthropic stores it encrypted and never displays it again.
5. Save, then enable the connector in a chat via the search-and-tools menu.

Connectors added on the web are available in the mobile apps too.

**If your account doesn't have the request-headers field yet**, the fallback is OAuth: the connector dialog's Advanced settings accept an OAuth client ID/secret, but your server would need to implement the OAuth flow — out of scope here. Simplest workaround until headers land for you: keep funnel off and use the vault from Claude Code / Desktop only.

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
- **`AUTH_TOKEN is required in http mode`** on startup — set it in `.env` (the server refuses to run unauthenticated HTTP by design).
- **Tools missing in Claude** — `write_note`/`append_note` disappear when `READ_ONLY=true`; `delete_note` only exists when `ALLOW_DELETE=true`.
