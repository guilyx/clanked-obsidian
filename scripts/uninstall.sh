#!/usr/bin/env bash
#
# clanked-obsidian uninstaller — cleanly removes everything install.sh set up.
#
#   curl -fsSL https://raw.githubusercontent.com/guilyx/clanked-obsidian/main/scripts/uninstall.sh | bash
#
# What it does:
#   1. Stops, disables and removes the systemd service
#   2. Turns off tailscale serve/funnel for this proxy
#   3. Optionally deletes the install directory (code + .env token + OAuth grants)
#
# Your vault is NEVER touched.
#
# Env overrides:
#   INSTALL_DIR     where it was installed (default /opt/clanked-obsidian)
#   PURGE=1         delete the install dir without asking
#   KEEP=1          keep the install dir without asking
#   NO_TAILSCALE=1  don't touch tailscale serve/funnel config

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/clanked-obsidian}"
SERVICE_NAME="clanked-obsidian"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*"; }

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
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

# --- 1. systemd service ------------------------------------------------------

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files --no-legend "$SERVICE_NAME.service" 2>/dev/null | grep -q "$SERVICE_NAME"; then
  info "Stopping and removing systemd service"
  $SUDO systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  $SUDO rm -f "/etc/systemd/system/$SERVICE_NAME.service"
  $SUDO systemctl daemon-reload
else
  info "No systemd service found — skipping"
fi

# --- 2. tailscale exposure ---------------------------------------------------

if [ -z "${NO_TAILSCALE:-}" ] && command -v tailscale >/dev/null 2>&1; then
  info "Turning off tailscale serve/funnel on HTTPS 443"
  $SUDO tailscale funnel --https=443 off 2>/dev/null || true
  $SUDO tailscale serve --https=443 off 2>/dev/null || true
  warn "If you were serving OTHER apps via tailscale on port 443, re-check with: tailscale serve status"
else
  info "Leaving tailscale config alone"
fi

# --- 3. install directory ----------------------------------------------------

if [ -d "$INSTALL_DIR" ]; then
  DELETE=""
  if [ -n "${PURGE:-}" ]; then
    DELETE=yes
  elif [ -n "${KEEP:-}" ]; then
    DELETE=no
  else
    REPLY="$(prompt "Delete $INSTALL_DIR? This removes the code, the .env auth token, and OAuth grants (your vault is untouched) [y/N]: ")"
    case "$REPLY" in
      y|Y|yes|YES) DELETE=yes ;;
      *) DELETE=no ;;
    esac
  fi
  if [ "$DELETE" = "yes" ]; then
    info "Deleting $INSTALL_DIR"
    rm -rf "$INSTALL_DIR" 2>/dev/null || $SUDO rm -rf "$INSTALL_DIR"
  else
    info "Keeping $INSTALL_DIR (delete later with: sudo rm -rf $INSTALL_DIR)"
  fi
else
  info "No install directory at $INSTALL_DIR — skipping"
fi

# --- 4. reminders ------------------------------------------------------------

echo
info "Uninstalled. Loose ends to clean up in your Claude clients:"
echo "  - Claude Code:     claude mcp remove obsidian"
echo "  - Claude Desktop:  remove the 'obsidian' entry from claude_desktop_config.json"
echo "  - claude.ai:       Settings -> Connectors -> remove the connector"
