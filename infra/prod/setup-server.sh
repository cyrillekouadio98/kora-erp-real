#!/usr/bin/env bash
# Préparation d'un serveur Ubuntu 22.04/24.04 neuf pour Kora ERP. À lancer une fois, en root :
#   sudo bash infra/prod/setup-server.sh
# Idempotent : peut être relancé sans dommage.
#
# - Docker Engine et le plugin Compose (dépôt officiel Docker)
# - pare-feu : SSH, HTTP et HTTPS uniquement
# - mises à jour de sécurité automatiques
# - fail2ban (tentatives SSH répétées), espace d'échange de 2 Go (builds Next.js)
# - sauvegarde quotidienne de la base à 2 h 30 (heure UTC)
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "À lancer en root (sudo)." >&2; exit 1; fi
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
export DEBIAN_FRONTEND=noninteractive

echo "→ Mises à jour du système"
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl gnupg ufw fail2ban unattended-upgrades git

echo "→ Docker (dépôt officiel)"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

echo "→ Pare-feu (SSH, HTTP, HTTPS)"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
# Remarque : Docker publie ses ports en contournant ufw. Seul Caddy publie des ports (80, 443),
# la base et l'API ne sont exposées que sur le réseau interne de Docker.

echo "→ Mises à jour de sécurité automatiques"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades

echo "→ fail2ban (SSH)"
systemctl enable --now fail2ban

echo "→ Espace d'échange de 2 Go"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "→ Sauvegarde quotidienne de la base (2 h 30 UTC)"
cat > /etc/cron.d/kora-backup <<EOF
30 2 * * * root $REPO_DIR/infra/prod/backup.sh >> /var/log/kora-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/kora-backup

echo
echo "Serveur prêt. Étapes suivantes (voir infra/prod/README.md) :"
echo "  1. $REPO_DIR/infra/prod/generate-env.sh <domaine> <email>"
echo "  2. $REPO_DIR/infra/prod/deploy.sh"
