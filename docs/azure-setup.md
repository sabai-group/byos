# BYOS Setup Guide — Microsoft Azure

Get BYOS (Bring Your Own Server) running on Azure. BYOS receives your suppliers' emails and WhatsApp messages and forwards them to SABAI 365 for processing.

**In this folder:** [`startup.sh`](startup.sh) — fill in your keys, paste into the VM's **Custom data** field (Part 2).

**Time:** ~15 min. **Maintenance:** none — BYOS auto-updates.

---

## Prerequisites

- **SABAI API key** — from your SABAI account manager.
- **OpenAI API key** — from [platform.openai.com](https://platform.openai.com).
- An **Azure account** signed in at [portal.azure.com](https://portal.azure.com). (New accounts get free credit.)

> **Cost:** Azure bills per resource, so expect roughly **$10–30/month** depending on VM size and region, plus small charges for the disk, the static IP, and egress.

---

## Part 1 — Fill in the startup script

Open [`startup.sh`](startup.sh) and complete the `FILL IN YOUR DETAILS HERE` block:

| Field | Value |
|---|---|
| `BYOS_ADMIN_PASSWORD` | Password for the BYOS web interface. |
| `SABAI_API_KEY` | Your SABAI API key. |
| `OPENAI_API_KEY` | Your OpenAI API key. |
| `SECRET_ENCRYPTION_KEY` | Any strong secret BYOS uses to encrypt supplier data (it's hashed before use). `openssl rand -hex 32` works. **Keep a copy** — SABAI doesn't have it, and you may need it to recover data. |

Copy the entire script — you'll paste it in Part 2.

---

## Part 2 — Create the VM

In the portal, search **Virtual machines** → **+ Create** → **Azure virtual machine**.

### Basics tab

- **Resource group:** *Create new* → `byos-rg`.
- **Virtual machine name:** `byos-server`.
- **Region:** closest to you, or per your data-residency needs.
- **Image:** **Ubuntu Server 24.04 LTS** (required — BYOS targets Ubuntu).
- **Size:** any burstable **B-series** with **≥2 GB RAM** is plenty (e.g. `B2ts_v2`/`B2als_v2` at 2 vCPU/4 GB, or `B1ms` at 1 vCPU/2 GB).
- **Authentication:** your call — SSH key or password. If you plan to use the **Serial console** for troubleshooting later, you'll need a password-based user (you can also add one afterward).
- **Public inbound ports:** *Allow selected ports* → **SSH (22)**, **HTTP (80)**, **HTTPS (443)**. Port 25 is added in Part 3.

### Networking tab — pin a static IP

A dynamic public IP can change on stop/deallocate and break your mail routing. Under **Public IP** → *Create new* → **SKU: Standard**, **Assignment: Static** → OK.

### Advanced tab — startup script

Paste your filled-in `startup.sh` into the **Custom data** field (under *Custom data and cloud init*).

> Use **Custom data**, not the separate **User data** field below it. cloud-init runs a `#!`-prefixed Custom data script on first boot; that's what installs BYOS.

**Review + create** → **Create**. After ~3–5 min, open the VM's **Overview** page and grab the **Public IP** — you'll use it everywhere from here.

---

## Part 3 — Open the mail port (NSG)

You opened 80/443/22 at create time; BYOS also needs inbound **25**, which isn't a preset.

VM → **Networking** (a.k.a. **Network settings**) → **Add inbound port rule**:

- **Destination port ranges:** `25`
- **Protocol:** `TCP`
- **Action:** `Allow`
- **Name:** `Allow-SMTP-25` (leave the suggested priority)

> Azure blocks *outbound* 25 by default — irrelevant here. BYOS only *receives* on 25 and forwards to SABAI over HTTPS, so inbound 25 is all you need.

---

## Part 4 — Access the web interface

Give it ~5 min to finish first boot, then visit `http://YOUR_PUBLIC_IP` and log in with `BYOS_ADMIN_PASSWORD`. From here you manage suppliers, check WhatsApp status, and monitor incoming messages.

---

## Part 5 — Link WhatsApp

In the web interface, open the **WhatsApp Linking** panel (click **Force New QR** if no code shows). On your phone: WhatsApp → **Settings → Linked Devices → Link a Device** → scan. The session persists until WhatsApp logs it out.

---

## Part 6 — Inbound email

SABAI points a subdomain (e.g. `yourcompany.sabai365.ai`) at your server via an MX record. **Send your static public IP to your account manager**; once they confirm, suppliers email `offers@yourcompany.sabai365.ai` and BYOS ingests automatically. Your server listens on port 25 (opened in Part 3).

---

## Automatic updates

BYOS detects new SABAI releases within an hour and restarts on the new version. No action needed.

---

## Troubleshooting

Can't reach `http://YOUR_IP` after a few minutes? SSH in (or VM → **Help → Serial console**, which needs **Boot diagnostics** enabled under **Help → Boot diagnostics** and a password user), then:

```
sudo cat /var/log/byos-startup.log        # startup log
cd /opt/byos && sudo docker compose ps    # container status
```

Also confirm ports 80/443/25 under **Networking → Inbound port rules**. WhatsApp dropped? Re-scan the QR — normal if the session is logged out. Stuck? Send your account manager the output of `sudo cat /var/log/byos-startup.log`.

---

## Part 7 — Enable HTTPS (optional)

Once your subdomain is live, SSH in (or use Serial console) and:

```
sudo -i
cd /opt/byos
cat > Caddyfile <<'EOF'
yourcompany.sabai365.ai {
   reverse_proxy byos:8787
}
EOF
docker compose restart caddy
```

Swap in your real subdomain. Caddy fetches a cert within ~30s; then `https://yourcompany.sabai365.ai` should load with a padlock.

---

## Summary

| What | Value |
|---|---|
| Web interface | `http://YOUR_PUBLIC_IP` (or `https://YOUR_DOMAIN` after Part 7) |
| Email (SMTP) port | `YOUR_PUBLIC_IP:25` |
| Updates | Automatic (hourly check) |
| Config file | `/opt/byos/.env` |
| Startup log | `/var/log/byos-startup.log` |

*Need help? Contact your SABAI account manager.*
