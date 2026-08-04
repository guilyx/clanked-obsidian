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
# Re-running is safe: it updates the code, keeps the existing .env (no
# prompts), rebuilds, and restarts the service. Delete .env to reconfigure.
#
# Optional env overrides:
#   INSTALL_DIR   where to install (default /opt/clanked-obsidian)
#   PORT          HTTP port (default 8484)
#   READ_ONLY     true/false (default false)
#   OAUTH_ENABLED true/false (default true) — OAuth endpoints for claude.ai connectors
#   DAILY_NOTES_FOLDER  vault-relative daily notes folder (default empty)
#   NO_SYSTEMD=1  skip systemd service installation
#   NO_TAILSCALE=1  skip tailscale serve setup
#   CLANKED_REPO / CLANKED_BRANCH  alternate git source (for development)
#
# Uninstall later with:
#   curl -fsSL https://raw.githubusercontent.com/guilyx/clanked-obsidian/main/scripts/uninstall.sh | bash

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

env_get() { sed -n "s/^$2=//p" "$1" | head -1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  fi
fi
CAN_ROOT=0
if [ "$(id -u)" -eq 0 ] || [ -n "$SUDO" ]; then CAN_ROOT=1; fi

# --- 1. Dependencies -------------------------------------------------------

command -v git >/dev/null 2>&1 || die "git is required. Install it and re-run."
command -v curl >/dev/null 2>&1 || die "curl is required. Install it and re-run."

if ! command -v node >/dev/null 2>&1; then
  die "Node.js >= 20 is required. Install it first, e.g.:
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
or with nvm:
  nvm install 22"
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node.js >= 20 required, found $(node --version) at $NODE_BIN.
If you use nvm, run 'nvm use 22' (or 'nvm install 22') in this shell and re-run."
fi

# Always use the npm that ships alongside the resolved node binary. This
# sidesteps the classic broken combo of a distro apt npm
# (/usr/share/nodejs/npm) paired with an nvm-installed node, which dies with
# "Cannot find module 'semver'".
NPM="$(dirname "$NODE_BIN")/npm"
if [ ! -x "$NPM" ]; then
  NPM="$(command -v npm || true)"
fi
[ -n "$NPM" ] || die "npm not found (it normally ships with Node.js)."
if ! "$NPM" --version >/dev/null 2>&1; then
  die "npm at $NPM is broken — usually a distro npm mixed with an nvm node.
Fix with ONE of these, then re-run:
  nvm install-latest-npm      # give nvm's node a matching npm
  sudo apt-get remove npm     # drop the distro npm so nvm's is used"
fi

# --- 2. Clone or update ----------------------------------------------------

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing install in $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout -q "$BRANCH" 2>/dev/null || git -C "$INSTALL_DIR" checkout -q -b "$BRANCH" "origin/$BRANCH"
  if ! git -C "$INSTALL_DIR" pull --ff-only -q origin "$BRANCH" 2>/dev/null; then
    # Diverged from origin (e.g. after a force-push upstream). The install
    # dir is disposable code; .env is untracked and survives the reset.
    warn "Local copy diverged from origin/$BRANCH — resetting to it"
    git -C "$INSTALL_DIR" reset --hard -q "origin/$BRANCH"
  fi
else
  info "Cloning into $INSTALL_DIR"
  if ! mkdir -p "$INSTALL_DIR" 2>/dev/null; then
    [ -n "$SUDO" ] || die "Cannot create $INSTALL_DIR (no sudo available). Set INSTALL_DIR to a writable path."
    $SUDO mkdir -p "$INSTALL_DIR"
    $SUDO chown "$(id -un):$(id -gn)" "$INSTALL_DIR"
  fi
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

# --- 3. Configuration ------------------------------------------------------
# An existing .env wins: re-runs never prompt and never rotate the token.

ENV_FILE="$INSTALL_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  info "Keeping existing $ENV_FILE (delete it to reconfigure)"
  EXISTING_VAULT="$(env_get "$ENV_FILE" VAULT_PATH)"
  if [ -n "${VAULT_PATH:-}" ] && [ "$VAULT_PATH" != "$EXISTING_VAULT" ]; then
    warn "Ignoring VAULT_PATH=$VAULT_PATH — .env already has $EXISTING_VAULT"
  fi
  VAULT_PATH="$EXISTING_VAULT"
  AUTH_TOKEN="$(env_get "$ENV_FILE" AUTH_TOKEN)"
  PORT="$(env_get "$ENV_FILE" PORT)"
  PORT="${PORT:-8484}"
  OAUTH_ENABLED="$(env_get "$ENV_FILE" OAUTH_ENABLED)"
  OAUTH_ENABLED="${OAUTH_ENABLED:-true}"
  DATA_DIR="$(env_get "$ENV_FILE" DATA_DIR)"
  DATA_DIR="${DATA_DIR:-$INSTALL_DIR/data}"
  [ -n "$VAULT_PATH" ] || die "Existing $ENV_FILE has no VAULT_PATH. Delete it and re-run."
else
  if [ -z "${VAULT_PATH:-}" ]; then
    VAULT_PATH="$(prompt "Absolute path to your Obsidian vault: ")"
  fi
  [ -n "$VAULT_PATH" ] || die "VAULT_PATH is required (set it as an env var for non-interactive installs)."
  VAULT_PATH="${VAULT_PATH%/}"
  case "$VAULT_PATH" in
    /*) ;;
    *) die "VAULT_PATH must be absolute, got: $VAULT_PATH" ;;
  esac
  [ -d "$VAULT_PATH" ] || die "No such directory: $VAULT_PATH"

  # Two auth paths, both always available to choose from:
  #   bearer — static token header; Claude Code / Desktop / mcp-remote
  #   oauth  — claude.ai web+mobile custom connectors (Pro/Max plans only
  #            offer OAuth in the connector dialog, so this is the only way
  #            for claude.ai to connect)
  if [ -z "${OAUTH_ENABLED:-}" ]; then
    echo
    echo "How will Claude connect? Bearer-token auth (Claude Code / Desktop over"
    echo "your tailnet) is always on. OAuth adds support for claude.ai web/mobile"
    echo "custom connectors (their dialog only offers OAuth on Pro/Max plans)."
    REPLY="$(prompt "Also enable OAuth for claude.ai? [Y/n]: ")"
    case "$REPLY" in
      n|N|no|NO) OAUTH_ENABLED=false ;;
      *) OAUTH_ENABLED=true ;;
    esac
  fi

  if command -v openssl >/dev/null 2>&1; then
    AUTH_TOKEN="$(openssl rand -hex 32)"
  else
    AUTH_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  fi
  DATA_DIR="$INSTALL_DIR/data"
  info "Generating $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
VAULT_PATH=$VAULT_PATH
AUTH_TOKEN=$AUTH_TOKEN
MCP_TRANSPORT=http
PORT=$PORT
BIND_HOST=127.0.0.1
READ_ONLY=${READ_ONLY:-false}
ALLOW_DELETE=false
OAUTH_ENABLED=$OAUTH_ENABLED
DATA_DIR=$DATA_DIR
DAILY_NOTES_FOLDER=${DAILY_NOTES_FOLDER:-}
EOF
  chmod 600 "$ENV_FILE"
fi
mkdir -p "$DATA_DIR"

# --- 4. Build --------------------------------------------------------------

info "Installing dependencies and building (npm: $NPM)"
(cd "$INSTALL_DIR" && "$NPM" ci --silent && "$NPM" run build --silent)

# --- 5. systemd service ----------------------------------------------------

STARTED_VIA_SYSTEMD=0
if [ -z "${NO_SYSTEMD:-}" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] && [ "$CAN_ROOT" -eq 1 ]; then
  info "Installing systemd service ($SERVICE_NAME)"
  UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"
  # Note: ExecStart pins the node binary found right now. If that node came
  # from nvm and you later remove that version, re-run this installer.
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
ExecStart=$NODE_BIN $INSTALL_DIR/dist/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$VAULT_PATH $DATA_DIR
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$SERVICE_NAME"
  # Restart (not just start) so re-runs pick up the freshly built code.
  $SUDO systemctl restart "$SERVICE_NAME"
  STARTED_VIA_SYSTEMD=1
else
  warn "Skipping systemd setup. Start manually with:"
  warn "  cd $INSTALL_DIR && $NPM start"
fi

# --- 6. Health check -------------------------------------------------------

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

# --- 7. Tailscale ----------------------------------------------------------

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

# --- 8. Summary ------------------------------------------------------------

URL_SHOWN="https://<nuc>.<tailnet>.ts.net/mcp"
if [ -n "$TS_HOST" ]; then URL_SHOWN="https://$TS_HOST/mcp"; fi

echo
info "Done. MCP URL: $URL_SHOWN"
echo
echo "── Path 1: bearer token — Claude Code / Claude Desktop (device in your tailnet)"
echo
echo "    claude mcp add --transport http obsidian $URL_SHOWN \\"
echo "      --header \"Authorization: Bearer $AUTH_TOKEN\""
echo
if [ "$OAUTH_ENABLED" = "true" ]; then
  echo "── Path 2: OAuth — claude.ai custom connector (web + mobile, Pro/Max)"
  echo
  echo "    1. Make it publicly reachable:  sudo tailscale funnel --bg $PORT"
  echo "    2. claude.ai -> Settings -> Connectors -> Add custom connector"
  echo "    3. URL: $URL_SHOWN"
  echo "       Leave 'Advanced settings' (Client ID / Secret) EMPTY — the"
  echo "       connector registers itself automatically."
  echo "    4. Click Connect: a browser page asks for your vault access key."
  echo "       Paste:  $AUTH_TOKEN"
else
  echo "── OAuth is disabled (claude.ai web/mobile connectors won't work)."
  echo "   Enable it later: set OAUTH_ENABLED=true in $ENV_FILE and restart."
fi
echo
echo "  Uninstall:  curl -fsSL https://raw.githubusercontent.com/guilyx/clanked-obsidian/main/scripts/uninstall.sh | bash"
echo "  Docs:       https://github.com/guilyx/clanked-obsidian/blob/main/docs/connecting-claude.md"
