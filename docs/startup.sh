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

# Any strong secret (UTF-8); BYOS SHA-256-hashes it for AES-256-GCM. Example: openssl rand -hex 32
SECRET_ENCRYPTION_KEY=""

# ---- END OF YOUR DETAILS ----


set -e
if [ -z "$SECRET_ENCRYPTION_KEY" ]; then
  echo "BYOS startup error: SECRET_ENCRYPTION_KEY is required." >&2
  echo "Use a long random value (e.g. openssl rand -hex 32)." >&2
  echo "Paste the output into startup.sh and redeploy." >&2
  exit 1
fi
exec > /var/log/byos-startup.log 2>&1

echo "=== BYOS startup: $(date) ==="

# Install Docker
echo "Installing Docker..."
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# Configure firewall
echo "Configuring firewall..."
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 2525/tcp
ufw --force enable

# Create app directory
mkdir -p /opt/byos
cd /opt/byos

# Write .env
cat > .env <<EOF
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

# Write Caddyfile — plain HTTP reverse proxy to start with.
# Once a domain is assigned, update this file to enable HTTPS (see docs).
cat > Caddyfile <<'EOF'
:80 {
    reverse_proxy byos:8787
}
EOF

# Write docker-compose.yml (includes Watchtower for auto-updates)
cat > docker-compose.yml <<'COMPOSE'
services:
  byos:
    image: ghcr.io/sabai-group/byos:latest
    env_file:
      - .env
    ports:
      - "${BYOS_SMTP_PORT:-2525}:2525"
    expose:
      - "8787"
    volumes:
      - byos_whatsapp_auth:/app/data/.wwebjs_auth
      - byos_runtime:/app/data/runtime
    restart: unless-stopped

  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
    restart: unless-stopped

  watchtower:
    image: containrrr/watchtower
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - WATCHTOWER_POLL_INTERVAL=1800
      - WATCHTOWER_CLEANUP=true
      - DOCKER_API_VERSION=1.43
    restart: unless-stopped

volumes:
  byos_whatsapp_auth:
  byos_runtime:
  caddy_data:
COMPOSE

# Pull and start
echo "Starting BYOS..."
docker compose pull
docker compose up -d

echo "=== BYOS startup complete: $(date) ==="
echo "Web interface will be available at http://$(curl -s ifconfig.me)"
