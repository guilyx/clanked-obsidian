# clanked-obsidian

A small, self-hosted [MCP](https://modelcontextprotocol.io) server that gives Claude safe access to an Obsidian vault living on a remote machine (a NUC, home server, VPS…), using **Tailscale** for transport security.

Because the server runs on the same machine as the vault, it reads the files directly — **no Obsidian plugin, no headless Obsidian, no Local REST API needed**. Obsidian doesn't even have to be running.

```
┌─ your laptop ──────────────┐
│ Claude Desktop / Claude    │──┐
│ Code (inside the tailnet)  │  │  tailscale serve (tailnet-only HTTPS)
└────────────────────────────┘  │
                                ▼
┌─ claude.ai (web/mobile) ───┐  ┌─ NUC ────────────────────────────────┐
│ custom connector           │──►  tailscale ──► clanked-obsidian ──►  │
│ (public HTTPS + token)     │  │  funnel        127.0.0.1:8484  vault │
└────────────────────────────┘  └──────────────────────────────────────┘
```

Two exposure modes, same server:

| Mode | Command on the NUC | Who can reach it | Use with |
|---|---|---|---|
| **Tailnet-only** | `tailscale serve` | Only devices in your tailnet | Claude Desktop, Claude Code |
| **Public** | `tailscale funnel` | Anyone with the URL (auth token required) | claude.ai web + mobile custom connector |

Start with tailnet-only. Turn on funnel only if you want your vault from claude.ai on the web or your phone.

## Tools exposed to Claude

| Tool | What it does |
|---|---|
| `list_notes` | List notes (most recently modified first), optionally scoped to a folder |
| `list_folders` | List all folders in the vault |
| `read_note` | Read one note |
| `search_notes` | Case-insensitive full-text + filename search |
| `daily_note` | Read the daily note for a date (`YYYY-MM-DD.md` convention) |
| `write_note` | Create a note (overwriting requires an explicit flag) — hidden if `READ_ONLY=true` |
| `append_note` | Append to a note (great for logging to daily notes) — hidden if `READ_ONLY=true` |
| `delete_note` | Delete a note — only registered if `ALLOW_DELETE=true` |

Safety rails (always on): paths are jailed to the vault root (`..`, absolute paths, and escaping symlinks are refused), `.obsidian`/`.trash`/`.git` and any `EXCLUDE_DIRS` are invisible, writes are limited to `.md` files, and reads are size-capped.

## Setup on the NUC

Prerequisites: Node 20+, Tailscale already up (`tailscale status` works), and the vault synced to the NUC (Syncthing, Obsidian Sync via a headless client, git — whatever you already use).

### One-liner install

```bash
curl -fsSL https://raw.githubusercontent.com/guilyx/clanked-obsidian/main/scripts/install.sh | bash
```

It prompts for your vault path, then clones to `/opt/clanked-obsidian`, builds, generates an `AUTH_TOKEN`, writes `.env` (chmod 600), installs + starts a hardened systemd service, runs `tailscale serve --bg 8484`, and prints the exact MCP URL, header, and `claude mcp add` command to paste. Re-running it updates an existing install and keeps your `.env`.

Non-interactive / customized:

```bash
VAULT_PATH=/home/you/vaults/main READ_ONLY=true \
  curl -fsSL https://raw.githubusercontent.com/guilyx/clanked-obsidian/main/scripts/install.sh | bash
```

Recognized env vars: `VAULT_PATH`, `INSTALL_DIR`, `PORT`, `READ_ONLY`, `DAILY_NOTES_FOLDER`, `NO_SYSTEMD=1`, `NO_TAILSCALE=1`.

### Manual install

```bash
git clone https://github.com/guilyx/clanked-obsidian.git /opt/clanked-obsidian
cd /opt/clanked-obsidian
npm ci && npm run build

cp .env.example .env
openssl rand -hex 32        # -> paste as AUTH_TOKEN in .env
nano .env                   # set VAULT_PATH, AUTH_TOKEN, DAILY_NOTES_FOLDER

npm start
# clanked-obsidian listening on http://127.0.0.1:8484/mcp ...
```

Sanity check from the NUC:

```bash
curl -s http://127.0.0.1:8484/healthz
# {"ok":true,"readOnly":false}
```

To keep it running, use the systemd unit in [`deploy/clanked-obsidian.service`](deploy/clanked-obsidian.service), or Docker:

```bash
docker compose up -d --build   # reads VAULT_PATH and AUTH_TOKEN from .env
```

## Expose it via Tailscale

The server binds to `127.0.0.1` only. Tailscale terminates HTTPS and proxies to it:

```bash
# Tailnet-only (Claude Desktop / Claude Code on your own devices):
sudo tailscale serve --bg 8484
# -> https://<nuc-hostname>.<tailnet-name>.ts.net/

# Public (needed for the claude.ai custom connector):
sudo tailscale funnel --bg 8484
```

`tailscale serve status` shows what's exposed; `sudo tailscale funnel off` / `serve off` turns it off. Funnel must be allowed in your tailnet ACLs (the command tells you if not).

> Even on funnel, every `/mcp` request without your `AUTH_TOKEN` gets a 401. But treat funnel as what it is: a public door with a good lock. Keep it off unless you use claude.ai/mobile.

## Connect Claude

Your MCP URL is `https://<nuc-hostname>.<tailnet-name>.ts.net/mcp`.

### Claude Code (laptop in the tailnet)

```bash
claude mcp add --transport http obsidian \
  https://<nuc>.<tailnet>.ts.net/mcp \
  --header "Authorization: Bearer <AUTH_TOKEN>"
```

### Claude Desktop (laptop in the tailnet)

Settings → Connectors → Add custom connector, URL as above. If your plan's connector dialog supports request headers, set `Authorization: Bearer <AUTH_TOKEN>`. Otherwise use the `mcp-remote` bridge in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<nuc>.<tailnet>.ts.net/mcp",
               "--header", "Authorization: Bearer ${OBSIDIAN_MCP_TOKEN}"],
      "env": { "OBSIDIAN_MCP_TOKEN": "<AUTH_TOKEN>" }
    }
  }
}
```

### claude.ai web / mobile (requires funnel)

Settings → Connectors → Add custom connector → URL `https://<nuc>.<tailnet>.ts.net/mcp`. Add the `Authorization: Bearer <AUTH_TOKEN>` request header (beta field in the connector dialog). The token is stored encrypted by Anthropic and sent on every request. See [docs/connecting-claude.md](docs/connecting-claude.md) for the click-by-click version and fallbacks.

## Configuration reference

All via environment variables (see [`.env.example`](.env.example)):

| Variable | Default | Notes |
|---|---|---|
| `VAULT_PATH` | — (required) | Absolute path to the vault |
| `AUTH_TOKEN` | — (required in http mode) | ≥16 chars; `openssl rand -hex 32` |
| `MCP_TRANSPORT` | `http` | `stdio` for a local Claude Desktop child process |
| `PORT` / `BIND_HOST` | `8484` / `127.0.0.1` | Keep loopback; Tailscale proxies to it |
| `READ_ONLY` | `false` | `true` removes all write tools |
| `ALLOW_DELETE` | `false` | `true` registers `delete_note` |
| `MAX_READ_BYTES` | `1000000` | Per-file read cap |
| `MAX_SEARCH_RESULTS` | `100` | Search result cap |
| `EXCLUDE_DIRS` | `.obsidian,.trash,.git` | Comma-separated, never exposed |
| `DAILY_NOTES_FOLDER` | vault root | Folder containing `YYYY-MM-DD.md` notes |

## Security model

Read [docs/security.md](docs/security.md) before turning on funnel. Short version: Tailscale provides transport encryption and (in serve mode) network-level access control; the bearer token is the application-level lock; the vault jail, read-only mode and delete gate limit blast radius; and you should consider `READ_ONLY=true` + `EXCLUDE_DIRS` for anything you'd hate to see modified or read.

## License

MIT
