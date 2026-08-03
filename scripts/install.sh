#!/usr/bin/env bash
#
# clanked-obsidian one-liner installer.
#
# Interactive:
#   curl -fsSL https://raw.githubusercontent.com/guilyx/clanked-obsidian/main/scripts/install.sh | bash
#
# Non-interactive (everything via env):
#   VAULT_PATH=/home/you/vaults/main \
#   curl -fsSL https://raw.githubusercontent.com/guilyx/clanked-obsidian/main/scripts/install.sh | bash
#
# Optional env overrides:
#   INSTALL_DIR   where to install (default /opt/clanked-obsidian)
#   PORT          HTTP port (default 8484)
#   READ_ONLY     true/false (default false)
#   DAILY_NOTES_FOLDER  vault-relative daily notes folder (default empty)
#   NO_SYSTEMD=1  skip systemd service installation
#   NO_TAILSCALE=1  skip tailscale serve setup
#   CLANKED_REPO / CLANKED_BRANCH  alternate git source (for development)

set -euo pipefail

REPO_URL="${CLANKED_REPO:-https://github.com/guilyx/clanked-obsidian.git}"
BRANCH="${CLANKED_BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/clanked-obsidian}"
PORT="${PORT:-8484}"
SERVICE_NAME="clanked-obsidian"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Works even when the script itself is piped into bash: prompt via /dev/tty.
prompt() {
  local message="$1" reply=""
  if [ -t 0 ]; then
    read -rp "$message" reply
  elif [ -r /dev/tty ]; then
    read -rp "$message" reply < /dev/tty
  fi
  printf '%s' "$reply"
}

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  fi
fi

# --- 1. Dependencies -------------------------------------------------------

command -v git >/dev/null 2>&1 || die "git is required. Install it and re-run."
command -v curl >/dev/null 2>&1 || die "curl is required. Install it and re-run."

if ! command -v node >/dev/null 2>&1; then
  die "Node.js >= 20 is required. Install it first, e.g.:
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node.js >= 20 required, found $(node --version). Upgrade Node and re-run."
fi
command -v npm >/dev/null 2>&1 || die "npm is required (comes with Node.js)."

# --- 2. Vault path ---------------------------------------------------------

if [ -z "${VAULT_PATH:-}" ]; then
  VAULT_PATH="$(prompt "Absolute path to your Obsidian vault: ")"
fi
[ -n "$VAULT_PATH" ] || die "VAULT_PATH is required (set it as an env var for non-interactive installs)."
case "$VAULT_PATH" in
  /*) ;;
  *) die "VAULT_PATH must be absolute, got: $VAULT_PATH" ;;
esac
[ -d "$VAULT_PATH" ] || die "No such directory: $VAULT_PATH"

# --- 3. Clone or update ----------------------------------------------------

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing install in $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  info "Cloning into $INSTALL_DIR"
  if ! mkdir -p "$INSTALL_DIR" 2>/dev/null; then
    [ -n "$SUDO" ] || die "Cannot create $INSTALL_DIR (no sudo available). Set INSTALL_DIR to a writable path."
    $SUDO mkdir -p "$INSTALL_DIR"
    $SUDO chown "$(id -un):$(id -gn)" "$INSTALL_DIR"
  fi
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

# --- 4. Build --------------------------------------------------------------

info "Installing dependencies and building"
(cd "$INSTALL_DIR" && npm ci --silent && npm run build --silent)

# --- 5. Configuration ------------------------------------------------------

ENV_FILE="$INSTALL_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  info "Keeping existing $ENV_FILE"
  AUTH_TOKEN="$(sed -n 's/^AUTH_TOKEN=//p' "$ENV_FILE" | head -1)"
else
  info "Generating $ENV_FILE"
  if command -v openssl >/dev/null 2>&1; then
    AUTH_TOKEN="$(openssl rand -hex 32)"
  else
    AUTH_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  fi
  cat > "$ENV_FILE" <<EOF
VAULT_PATH=$VAULT_PATH
AUTH_TOKEN=$AUTH_TOKEN
MCP_TRANSPORT=http
PORT=$PORT
BIND_HOST=127.0.0.1
READ_ONLY=${READ_ONLY:-false}
ALLOW_DELETE=false
DAILY_NOTES_FOLDER=${DAILY_NOTES_FOLDER:-}
EOF
  chmod 600 "$ENV_FILE"
fi

# --- 6. systemd service ----------------------------------------------------

CAN_ROOT=0
if [ "$(id -u)" -eq 0 ] || [ -n "$SUDO" ]; then CAN_ROOT=1; fi

STARTED_VIA_SYSTEMD=0
if [ -z "${NO_SYSTEMD:-}" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] && [ "$CAN_ROOT" -eq 1 ]; then
  info "Installing systemd service ($SERVICE_NAME)"
  UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"
  $SUDO tee "$UNIT_FILE" > /dev/null <<EOF
[Unit]
Description=clanked-obsidian MCP server (Obsidian vault access for Claude)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) $INSTALL_DIR/dist/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$VAULT_PATH
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now "$SERVICE_NAME"
  STARTED_VIA_SYSTEMD=1
else
  warn "Skipping systemd setup. Start manually with:"
  warn "  cd $INSTALL_DIR && npm start"
fi

# --- 7. Health check -------------------------------------------------------

if [ "$STARTED_VIA_SYSTEMD" -eq 1 ]; then
  for _ in $(seq 1 20); do
    if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    info "Server is up: http://127.0.0.1:$PORT/healthz"
  else
    die "Server did not come up. Check: journalctl -u $SERVICE_NAME -n 50"
  fi
fi

# --- 8. Tailscale ----------------------------------------------------------

TS_HOST=""
if [ -z "${NO_TAILSCALE:-}" ] && command -v tailscale >/dev/null 2>&1; then
  info "Exposing to your tailnet: tailscale serve --bg $PORT"
  if $SUDO tailscale serve --bg "$PORT"; then
    TS_HOST="$(tailscale status --json 2>/dev/null \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).Self.DNSName.replace(/\.$/,""))}catch{}})' \
      2>/dev/null || true)"
  else
    warn "tailscale serve failed — run it manually: sudo tailscale serve --bg $PORT"
  fi
else
  warn "Tailscale not configured by this script. Expose manually when ready:"
  warn "  sudo tailscale serve --bg $PORT     # tailnet-only"
fi

# --- 9. Summary ------------------------------------------------------------

echo
info "Done. Connection details:"
echo
if [ -n "$TS_HOST" ]; then
  echo "  MCP URL:    https://$TS_HOST/mcp"
else
  echo "  MCP URL:    https://<nuc>.<tailnet>.ts.net/mcp   (after tailscale serve)"
fi
echo "  Auth:       Authorization: Bearer $AUTH_TOKEN"
echo
echo "  Claude Code:"
if [ -n "$TS_HOST" ]; then
  echo "    claude mcp add --transport http obsidian https://$TS_HOST/mcp \\"
else
  echo "    claude mcp add --transport http obsidian https://<nuc>.<tailnet>.ts.net/mcp \\"
fi
echo "      --header \"Authorization: Bearer $AUTH_TOKEN\""
echo
echo "  For claude.ai (web/mobile), also run:  sudo tailscale funnel --bg $PORT"
echo "  Docs: https://github.com/guilyx/clanked-obsidian/blob/main/docs/connecting-claude.md"
