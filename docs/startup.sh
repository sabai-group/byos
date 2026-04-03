#!/bin/bash
# =============================================================
#  BYOS STARTUP SCRIPT
#  Fill in your details in the section below, then copy the
#  entire script and paste it into the "User Data" field when
#  creating your DigitalOcean Droplet.
# =============================================================

# ---- FILL IN YOUR DETAILS HERE ----

BYOS_ADMIN_PASSWORD=""        # Password for the BYOS web interface
SABAI_API_KEY=""              # Your SABAI API key (from your account manager)
OPENAI_API_KEY=""             # Your OpenAI API key

# Optional: leave blank to auto-generate a secure key
SECRET_ENCRYPTION_KEY=""

# ---- END OF YOUR DETAILS ----


set -e
exec > /var/log/byos-startup.log 2>&1

echo "=== BYOS startup: $(date) ==="

# Auto-generate SECRET_ENCRYPTION_KEY if not provided
if [ -z "$SECRET_ENCRYPTION_KEY" ]; then
  SECRET_ENCRYPTION_KEY=$(openssl rand -hex 32)
  echo "Generated SECRET_ENCRYPTION_KEY"
fi

# Install Docker
echo "Installing Docker..."
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# Configure firewall
echo "Configuring firewall..."
ufw allow OpenSSH
ufw allow 8787/tcp
ufw allow 2525/tcp
ufw --force enable

# Create app directory
mkdir -p /opt/byos
cd /opt/byos

# Write .env
cat > .env <<EOF
BYOS_PORT=8787
BYOS_SMTP_PORT=2525
BYOS_ADMIN_PASSWORD=${BYOS_ADMIN_PASSWORD}

SABAI_API_KEY=${SABAI_API_KEY}
SECRET_ENCRYPTION_KEY=${SECRET_ENCRYPTION_KEY}
SABAI_BASE_URL=https://sabai365-16c4b4eee4fe.herokuapp.com

OPENAI_API_KEY=${OPENAI_API_KEY}
BYOS_AI_MODEL=gpt-5-mini

WHATSAPP_HEADLESS=true
WHATSAPP_DEBUG=false
WHATSAPP_AUTH_PATH=/app/data/.wwebjs_auth
WHATSAPP_ARTIFACTS_DIR=/app/data/runtime/whatsapp
WHATSAPP_DEBOUNCE_MS=60000
WHATSAPP_LOCALE=en-US
WHATSAPP_TIMEZONE=UTC
WHATSAPP_USER_AGENT=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36
WHATSAPP_VIEWPORT_WIDTH=1366
WHATSAPP_VIEWPORT_HEIGHT=768
PUPPETEER_EXECUTABLE_PATH=/usr/bin/byos-browser
EOF

# Write docker-compose.yml (includes Watchtower for auto-updates)
cat > docker-compose.yml <<'COMPOSE'
services:
  byos:
    image: ghcr.io/sabai-group/byos:latest
    env_file:
      - .env
    ports:
      - "${BYOS_PORT:-8787}:8787"
      - "${BYOS_SMTP_PORT:-2525}:2525"
    volumes:
      - byos_whatsapp_auth:/app/data/.wwebjs_auth
      - byos_runtime:/app/data/runtime
    restart: unless-stopped

  watchtower:
    image: containrrr/watchtower
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - WATCHTOWER_POLL_INTERVAL=3600
      - WATCHTOWER_CLEANUP=true
    restart: unless-stopped

volumes:
  byos_whatsapp_auth:
  byos_runtime:
COMPOSE

# Pull and start
echo "Starting BYOS..."
docker compose pull
docker compose up -d

echo "=== BYOS startup complete: $(date) ==="
echo "Web interface will be available at http://$(curl -s ifconfig.me):8787"
