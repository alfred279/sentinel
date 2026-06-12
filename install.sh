#!/usr/bin/env bash
#
# Sentinel installer.
# Usage on the hub (Raspberry Pi 5 / Intel mini PC / any Linux box):
#
#   curl -fsSL https://raw.githubusercontent.com/alfred279/sentinel/main/install.sh | bash
#
# This installs Docker (if missing), downloads Sentinel, generates secrets,
# starts it, and registers it as a background service that survives reboots.
# No source build required — it pulls prebuilt images.

set -euo pipefail

REPO="alfred279/sentinel"          # <-- change to your GitHub repo
INSTALL_DIR="/opt/sentinel"
RAW="https://raw.githubusercontent.com/${REPO}/main"

info()  { echo -e "\033[1;36m==>\033[0m $*"; }
ok()    { echo -e "\033[1;32m✓\033[0m $*"; }
die()   { echo -e "\033[1;31m✗ $*\033[0m" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root (use: curl ... | sudo bash)"

# ── 1. Docker ──────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  info "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  ok "Docker installed"
else
  ok "Docker already present"
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"

# ── 2. Download Sentinel ───────────────────────────────────────────────────
info "Downloading Sentinel to ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}/db"
curl -fsSL "${RAW}/docker-compose.prod.yml" -o "${INSTALL_DIR}/docker-compose.yml"
curl -fsSL "${RAW}/go2rtc.yaml"             -o "${INSTALL_DIR}/go2rtc.yaml"
curl -fsSL "${RAW}/db/schema.sql"           -o "${INSTALL_DIR}/db/schema.sql"
ok "Downloaded"

# ── 3. Generate secrets (only on first install — never overwrite) ──────────
if [ ! -f "${INSTALL_DIR}/.env" ]; then
  info "Generating secrets..."
  cat > "${INSTALL_DIR}/.env" <<EOF
TZ=$(cat /etc/timezone 2>/dev/null || echo America/Chicago)
DB_USER=sentinel
DB_NAME=sentinel
DB_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
HUB_ENCRYPTION_KEY=$(openssl rand -hex 32)
SENTINEL_VERSION=latest
EOF
  chmod 600 "${INSTALL_DIR}/.env"
  ok "Secrets generated (stored in ${INSTALL_DIR}/.env — back this up)"
else
  ok "Existing config found — keeping your secrets"
fi

# ── 4. Pull images & start ─────────────────────────────────────────────────
info "Pulling images and starting Sentinel..."
cd "${INSTALL_DIR}"
docker compose pull
docker compose up -d

# ── 5. Register as a boot service so it self-heals + survives reboots ──────
info "Registering Sentinel as a system service..."
curl -fsSL "${RAW}/packaging/sentinel.service" -o /etc/systemd/system/sentinel.service
systemctl daemon-reload
systemctl enable sentinel.service
ok "Service registered (auto-starts on boot)"

# ── 6. Done ────────────────────────────────────────────────────────────────
IP=$(hostname -I | awk '{print $1}')
echo
ok "Sentinel is installed and running."
echo
echo "   App:     http://${IP}:8080"
echo "   Status:  http://${IP}:4000/health"
echo
echo "   Manage it with:  systemctl {start,stop,restart,status} sentinel"
echo "   For remote phone access, see docs/REMOTE_ACCESS.md (use Tailscale)."
echo
