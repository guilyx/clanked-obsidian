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

## Authentication: two paths

| Path | Used by | How it works |
|---|---|---|
| **Bearer token** | Claude Code, Claude Desktop, `mcp-remote`, curl | Send `Authorization: Bearer <AUTH_TOKEN>` on every request |
| **OAuth 2.1** (built-in) | **claude.ai custom connectors** (web + mobile) | claude.ai registers itself automatically (leave Client ID/Secret empty), then a browser page asks you to paste your vault access key once to approve |

Why both: on Pro/Max plans the claude.ai connector dialog only supports OAuth — there is no header field — so a plain bearer token can't work there. The server therefore ships a minimal single-user OAuth provider (dynamic client registration, authorization code + PKCE, refresh tokens, hashed at rest). Bearer stays the simplest path for Claude Code/Desktop inside your tailnet. The installer asks which you want; `OAUTH_ENABLED=false` turns the OAuth endpoints off entirely.

## Setup on the NUC

Prerequisites: Tailscale already up (`tailscale status` works) and the vault synced to the NUC (Syncthing, Obsidian Sync via a headless client, git — whatever you already use). Node.js is **not** a prerequisite: the installer uses your `node` if it's ≥ 20, finds one in `~/.nvm` if the shell doesn't expose it, and otherwise downloads a private, checksum-verified copy into the install dir without touching your system.

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

Recognized env vars: `VAULT_PATH`, `INSTALL_DIR`, `PORT`, `READ_ONLY`, `OAUTH_ENABLED`, `DAILY_NOTES_FOLDER`, `NODE_VERSION`, `NO_SYSTEMD=1`, `NO_TAILSCALE=1`.

Install troubleshooting:

- **`Cannot find module 'semver'` from npm** — a distro apt `npm` mixed with an nvm-installed `node`. The installer works around this by using the npm bundled with the node it selected; if npm is still broken, re-run with `NODE_VERSION=22.20.0` to force a private Node install.
- **Old system node (v12 etc.)** — handled automatically: the installer prefers nvm-installed versions and falls back to downloading its own Node into `<install dir>/.node`. `NODE_VERSION=x.y.z` pins the downloaded version.
- **Re-runs** never prompt and never rotate the token: config lives in `/opt/clanked-obsidian/.env`. Delete that file to reconfigure from scratch.
- **nvm-managed node + systemd** — the service pins the node binary path found at install time. If you later remove that nvm version, re-run the installer to re-pin.

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

### claude.ai web / mobile (requires funnel + OAuth)

1. `sudo tailscale funnel --bg 8484` on the NUC.
2. claude.ai → Settings → Connectors → Add custom connector → URL `https://<nuc>.<tailnet>.ts.net/mcp`.
3. **Leave Advanced settings (OAuth Client ID/Secret) empty** — the connector registers itself via dynamic client registration.
4. Click Connect; a browser page from your server asks for your vault access key. Paste the `AUTH_TOKEN` and approve.

See [docs/connecting-claude.md](docs/connecting-claude.md) for the click-by-click version and troubleshooting.

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
| `OAUTH_ENABLED` | `true` | OAuth endpoints for claude.ai connectors |
| `DATA_DIR` | `./data` | OAuth registrations + hashed tokens |
| `PUBLIC_URL` | derived from `Host` | Override external base URL in OAuth metadata |

## Updating and uninstalling

**Update:** re-run the install one-liner. It pulls the latest code, rebuilds, restarts the service, and keeps your `.env` (token, vault path) and OAuth grants untouched.

**Uninstall:**

```bash
curl -fsSL https://raw.githubusercontent.com/guilyx/clanked-obsidian/main/scripts/uninstall.sh | bash
```

Stops and removes the systemd service, turns off `tailscale serve`/`funnel`, and asks before deleting the install directory (which holds the code, `.env` token, and OAuth grants — your vault is never touched). Non-interactive: `PURGE=1` deletes without asking, `KEEP=1` keeps it, `NO_TAILSCALE=1` leaves tailscale config alone. Then remove the connector from your Claude clients (`claude mcp remove obsidian` / Desktop config / claude.ai settings).

## Security model

Read [docs/security.md](docs/security.md) before turning on funnel. Short version: Tailscale provides transport encryption and (in serve mode) network-level access control; the bearer token is the application-level lock; the vault jail, read-only mode and delete gate limit blast radius; and you should consider `READ_ONLY=true` + `EXCLUDE_DIRS` for anything you'd hate to see modified or read.

## License

MIT
