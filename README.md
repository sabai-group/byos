# BYOS

Open-source Bring Your Own Server ingress for SABAI 365.

**End-user tutorial (DigitalOcean):** [docs/digitalocean-setup.md](docs/digitalocean-setup.md) — step-by-step setup with screenshots; [`docs/startup.sh`](docs/startup.sh) is the Droplet cloud-init script referenced there.

It runs three things in one container:

- a small SMTP server for inbound offer emails,
- an unofficial WhatsApp client based on `whatsapp-web.js`,
- a password-protected web UI for managing suppliers and WhatsApp linking.

## What It Does

- Receives inbound email and WhatsApp messages.
- Fetches the encrypted supplier roster from Sabai (scoped to the customer identified by `SABAI_API_KEY`).
- Detects which supplier sent the message using the fetched roster plus AI.
- Redacts supplier-identifying mentions from the relayed subject/body text.
- Redacts file names and images from spreadsheet extensions.
- Encrypts the canonical supplier name with a BYOS-only key so SABAI ingest never sees plaintext identities (TLS is separate).
- Sends `SABAI_API_KEY` in `X-BYOS-API-Key` so SABAI can authenticate the BYOS client (HTTPS).
- Sends the sanitized payload to SABAI at `https://sabai365-16c4b4eee4fe.herokuapp.com` by default.

## Quick Start

1. Copy `.env.example` to `.env`.
2. Set `SABAI_API_KEY` to the customer's API key from the Sabai `customer` table. Set `SECRET_ENCRYPTION_KEY` on BYOS only — SABAI must not have this key.
3. Set `OPENAI_API_KEY`.
4. Start the service:

```bash
docker compose up --build
```

The web UI is available on `http://localhost:8787` by default.

## Important Env Vars

- `BYOS_ADMIN_PASSWORD`: Web UI password. Defaults to `365`.
- `SABAI_API_KEY`: Required. Customer-specific key from the Sabai `customer` table (`X-BYOS-API-Key` header). Also used to fetch the supplier roster.
- `SECRET_ENCRYPTION_KEY`: Required on BYOS. Any strong string; BYOS SHA-256-hashes it for AES-256-GCM. Never share this with SABAI.
- `SABAI_BASE_URL`: Defaults to `https://sabai365-16c4b4eee4fe.herokuapp.com`.
- `OPENAI_API_KEY`: AI provider key.
- `OPENAI_BASE_URL`: Optional override for OpenRouter or another OpenAI-compatible endpoint.
- `BYOS_AI_MODEL`: Defaults to `gpt-5-mini`.
- `WHATSAPP_DEBUG`: Enables verbose WhatsApp lifecycle logging and artifact capture.
- `WHATSAPP_ARTIFACTS_DIR`: Directory for WhatsApp debug logs, screenshots, and saved HTML.
- `WHATSAPP_USER_AGENT` / `WHATSAPP_LOCALE` / `WHATSAPP_TIMEZONE`: Optional browser identity tuning. The default UA looks like desktop Chrome on Linux (common for WhatsApp Web), while the Docker image runs Debian’s Chromium.
- `WHATSAPP_VIEWPORT_WIDTH` / `WHATSAPP_VIEWPORT_HEIGHT`: Desktop viewport tuning for Puppeteer.
- `PUPPETEER_EXECUTABLE_PATH`: Defaults to `/usr/bin/byos-browser`, which the Docker image symlinks to `/usr/bin/chromium` (Debian package, all supported architectures).

## Supplier Roster

The supplier roster is fetched live from Sabai via the `/byos/suppliers` API endpoint
(authenticated by `SABAI_API_KEY`). Suppliers can be added through the web UI, which
creates them on Sabai with encrypted names.

## WhatsApp Linking

- The web UI shows linking status and the QR when one is active; use **Force New QR** to wipe the session and get a new code. Debug artifacts appear when `WHATSAPP_DEBUG=true`.

## WhatsApp session persistence (Docker)

- Persist `WHATSAPP_AUTH_PATH` (default `/app/data/.wwebjs_auth`) with a **Docker named volume**, not a macOS bind mount, so Chromium’s profile/IndexedDB behaves reliably.
- That path is a **volume mount point** inside the container; “Force New QR” deletes **only the files inside** it (not the directory itself), which avoids `EBUSY` / “Device or resource busy” errors.
- **Stop the container with `docker stop`** (SIGTERM) or Ctrl+C in the foreground so BYOS can run graceful shutdown. `docker kill` / SIGKILL can corrupt the profile and force a new QR on next boot.
- BYOS disables Puppeteer’s default `handleSIGINT` / `handleSIGTERM` handlers so Chrome is only closed via BYOS’s own shutdown path (cleaner writes to the volume).
- On startup, logs include `startup_restore_confirmed` when the old session came back, or `startup_restore_failed_relink_required` when WhatsApp is asking to scan a QR again.

## WhatsApp Debugging

When `WHATSAPP_DEBUG=true`, BYOS writes a JSON-lines event log to:

`/app/data/runtime/whatsapp/events.log`

On auth failures or disconnects it also attempts to save:

- a screenshot of the WhatsApp page
- the current page HTML

These artifact paths are shown in the web UI under the WhatsApp Linking panel.

## [DEVELOPERS] Publishing to GHCR

Customer Droplets pull `ghcr.io/sabai-group/byos:latest`. After making changes, build and push a new image.

**1. Give `gh` package scopes** (OAuth token must include `read:packages` and `write:packages`):

```bash
gh auth refresh -h github.com -s read:packages -s write:packages
```

Complete the browser/device flow. Check with `gh auth status` — the token line should list `read:packages` and `write:packages`.

**2. Log Docker into GHCR:**

```bash
docker logout ghcr.io 2>/dev/null || true
gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin
```

**3. Build and push** (from `backend/byos/`):

```bash
docker build -t ghcr.io/sabai-group/byos:latest .
docker push ghcr.io/sabai-group/byos:latest
```

For multi-arch builds (amd64 + arm64):

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/sabai-group/byos:latest --push .
```

The package must be **public** on GitHub (Settings → Packages → `byos` → Danger Zone → Make public) so customer Droplets can pull without authentication. Watchtower on the Droplet polls hourly and restarts with the new image automatically.

### Push fails: `permission_denied: The token provided does not match expected scopes`

Usually the token on disk is **stale** or **missing `write:packages`**. Run step 1 again, then **`docker logout ghcr.io`** and repeat step 2 so Docker does not reuse an old login.
