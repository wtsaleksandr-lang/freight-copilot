# Using Freight Copilot remotely (phone, laptop, anywhere)

Your PC is the home base — Maersk session, Playwright, Chrome profile all live there. Remote access means *reaching that PC* from another device. Three options, ordered easiest → most flexible.

---

## Prerequisite for any option: keep the PC awake + the server running

The Startup folder shortcut already auto-starts the server when you sign in. But Windows sleep will silently kill it.

**Disable sleep when plugged in:**
1. Settings → System → Power & battery → Screen and sleep
2. Set "When plugged in, put my device to sleep after" → **Never**
3. (Optional) keep "When plugged in, turn my screen off" set to whatever you like — server still runs with screen off.

If your PC ever does Windows-Update reboots, the auto-start shortcut brings the server back up after login.

---

## Option 1 — Local Wi-Fi only (easiest, ~2 min)

Use this if you only need access from your couch / kitchen / wherever in the house.

1. Restart the dashboard with the LAN-binding flag:
   ```
   pnpm dev serve --host 0.0.0.0
   ```
   The terminal will print all reachable IPs, e.g. `http://192.168.1.42:3000`.
2. On your phone (same Wi-Fi), open that URL in any browser.
3. Done. **Cannot be reached from outside your home Wi-Fi**, so security isn't really a concern here.

To make this the default for the desktop shortcut, edit `start-dashboard.bat` and change `pnpm dev serve` to `pnpm dev serve --host 0.0.0.0`.

---

## Option 2 — Tailscale (recommended, ~10 min, free for personal use)

Use this if you want access from **anywhere** with internet — coffee shop, client meeting, hotel — without exposing anything publicly.

Tailscale builds a private encrypted mesh just between your own devices. Only logged-in devices on your tailnet can reach the server.

### Setup

1. Sign up at [tailscale.com](https://tailscale.com/) (free for personal).
2. **Install Tailscale on your PC**: download from their site, run installer, sign in.
3. **Install Tailscale on your phone**: App Store / Play Store, sign in to the same account.
4. Restart the dashboard with `--host 0.0.0.0`:
   ```
   pnpm dev serve --host 0.0.0.0
   ```
5. In the Tailscale admin panel (or the app), find your PC's tailnet IP — looks like `100.x.y.z`.
6. On your phone, open `http://100.x.y.z:3000` (replace with your actual IP). Bookmark it.

That's it. You can now use the dashboard from anywhere, only your own devices can reach it, traffic is encrypted, and there's no public URL anyone could discover.

### Optional: add a hostname (Tailscale "MagicDNS")

In Tailscale admin → DNS → enable MagicDNS. Then your URL becomes something like `http://owner-pc:3000` instead of an IP — easier to remember.

---

## Option 3 — Cloudflare Tunnel (public URL, ~15 min)

Use this if you want a real public URL like `https://something.trycloudflare.com` — e.g. so you can share access with someone, or use from a device you can't install Tailscale on.

**Important: this exposes your dashboard to the internet.** You MUST enable Basic auth (see "Securing the dashboard" below).

### Setup (free, ephemeral URL)

1. Install `cloudflared`: download from [github.com/cloudflare/cloudflared](https://github.com/cloudflare/cloudflared/releases) for Windows.
2. Restart the dashboard with `--host 0.0.0.0` and Basic auth enabled (see below).
3. In a terminal:
   ```
   cloudflared tunnel --url http://localhost:3000
   ```
4. Cloudflare prints a URL like `https://flying-orange-1234.trycloudflare.com`. That URL works from any device, anywhere.
5. Caveat: the URL changes each time you restart cloudflared. For a stable URL you need a Cloudflare account + a domain (still free).

---

## Securing the dashboard (required for options 2 & 3)

Once the dashboard is reachable beyond `localhost`, **you should enable Basic auth** so anyone who guesses the URL can't run quotes on your account (which costs you Anthropic credits + uses your Maersk session).

1. Edit `C:\Users\Owner\.codex\freight-copilot\.env`:
   ```
   BASIC_AUTH_USER=alex
   BASIC_AUTH_PASS=some-long-random-password-here
   ```
2. Restart the dashboard.
3. The browser will prompt for username + password the first time, then remember it.

**Strongly recommended**: use a long random password (20+ characters). Generate one with `openssl rand -base64 24` if you have Git Bash open.

---

## Mobile UI

The dashboard adapts to phone screens — form fields stack vertically, tables scroll horizontally, the carrier checklist becomes a single column. Sliders, buttons, and copy-to-clipboard all work on touch.

Things that still need a real screen / desktop:
- **Recording a workflow** (Record tab) — opens a Chromium window on the PC, you have to click in that window.
- **Solving a captcha during a quote** — same reason.

Everything else (paste a client request, click Generate full quote, copy the email back) works fine on a phone.

---

## Quick summary

| You want… | Use this |
|---|---|
| Quick access from couch / phone, same Wi-Fi | `pnpm dev serve --host 0.0.0.0` + your PC's local IP |
| Access from anywhere, secure, free | Tailscale + `--host 0.0.0.0` + Basic auth |
| Public URL (share / iPad without Tailscale) | Cloudflare Tunnel + Basic auth (mandatory) |
| Set-and-forget always-on | Disable Windows sleep, keep PC plugged in, auto-start shortcut already in place |
