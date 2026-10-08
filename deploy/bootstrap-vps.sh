#!/usr/bin/env bash
# Bootstrap de SEGURANÇA da VPS (Ubuntu LTS). Rodar UMA vez, como root, num host novo.
# Firewall (só SSH+80+443), SSH por chave, updates automáticos, swap, log rotation
# do Docker. NÃO instala a app (isso é o deploy).
set -euo pipefail

SSH_PORT="${SSH_PORT:-22}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"

echo "==> Atualizando pacotes"
apt-get update && apt-get -y upgrade

echo "==> Atualizações de segurança automáticas (unattended-upgrades)"
apt-get -y install unattended-upgrades fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades || true

echo "==> Usuário de deploy (sudo, sem senha de login)"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
  usermod -aG sudo "$DEPLOY_USER"
fi
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
echo "  -> copie sua chave pública para /home/$DEPLOY_USER/.ssh/authorized_keys"

echo "==> SSH: só chave, sem root, porta ${SSH_PORT}"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i "s/^#\?Port .*/Port ${SSH_PORT}/" /etc/ssh/sshd_config
systemctl restart ssh || systemctl restart sshd || true

echo "==> Firewall (ufw): só SSH + 80 + 443; bloqueia o resto"
apt-get -y install ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp"
ufw allow 80/tcp
ufw allow 443/tcp
# Postgres/Redis NUNCA expostos: ficam só na rede interna do Docker (sem ufw allow).
ufw --force enable

echo "==> Swap (evita OOM-kill em pico; Postgres+Redis+workers)"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

echo "==> Docker + rotação de log global (json-file max-size/max-file)"
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "5" } }
JSON
systemctl restart docker
usermod -aG docker "$DEPLOY_USER" || true

echo "==> Pronto. Faça login como ${DEPLOY_USER} na porta ${SSH_PORT} e rode o deploy."
