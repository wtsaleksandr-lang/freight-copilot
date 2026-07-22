# LoadMode deployment and remote access

LoadMode supports two operating modes. They can use the same PostgreSQL database, but only one instance should normally be used for writes at a time.

## Mode A: always-on desktop PC with Tailscale

This is the original anywhere-access setup and remains the best option for carrier portal automation that depends on the PC's Chrome profile, cookies, MFA, or captcha handling.

### One-time setup

1. Install Node.js, pnpm, Git, and Tailscale on the desktop PC.
2. Clone this repository and run:

   ```powershell
   pnpm install --frozen-lockfile
   pnpm exec playwright install chromium
   Copy-Item .env.example .env
   ```

3. Edit `.env` and provide at least:

   ```text
   DATABASE_URL=...
   ANTHROPIC_API_KEY=...
   BASIC_AUTH_USER=...
   BASIC_AUTH_PASS=...
   USE_REAL_CHROME=false
   ```

4. Test the production launcher:

   ```powershell
   .\start-dashboard.bat
   ```

5. Install automatic startup after Windows sign-in:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install-windows-startup.ps1
   ```

6. In Windows power settings, prevent sleep while plugged in.
7. Sign in to Tailscale on the desktop and remote devices.
8. Open `http://<desktop-tailscale-name>:3000` or `http://<100.x.y.z>:3000`.

The launcher builds the latest checked-out code, binds to `0.0.0.0`, and starts the compiled production server. The dashboard remains protected by HTTP Basic authentication.

### Updating the desktop installation

Stop the running dashboard, then run:

```powershell
git switch main
git pull
pnpm install --frozen-lockfile
.\start-dashboard.bat
```

### Desktop health check

Open:

```text
http://localhost:3000/api/health/ready
```

Or use **More → System check** in the dashboard.

## Mode B: Replit deployment

Use Replit when the quote library, shipment board, document parsing, reports, and client-PDF tools must remain available while the desktop PC is off. Carrier portal browser automation may still require the desktop mode.

### Replit secrets

Set these in the deployment environment, never in GitHub:

```text
DATABASE_URL
ANTHROPIC_API_KEY
BASIC_AUTH_USER
BASIC_AUTH_PASS
```

Optional:

```text
AI_PROVIDER
AI_MODEL
AI_MODEL_FALLBACK
GEMINI_API_KEY
DELAYPREDICT_URL
```

Keep `USE_REAL_CHROME=false` on Replit.

### Replit commands

Build command:

```text
pnpm deploy:prepare && pnpm exec playwright install chromium
```

Run command:

```text
pnpm start
```

Replit supplies `PORT`; the production entrypoint binds to `0.0.0.0` automatically.

Database schema changes must be applied deliberately before or during a controlled deployment:

```text
pnpm db:push
```

Do not run the seed script on every normal restart. Existing operational records live in the PostgreSQL database and must not depend on the deployment filesystem.

## Post-deployment verification

After either deployment method:

1. Sign in through Basic Auth.
2. Run **More → System check**.
3. Create or reopen one test quote.
4. Open one shipment and save a test follow-up.
5. Restart the app.
6. Confirm the quote and follow-up still exist.
7. Generate a client-quote preview and PDF.
8. Confirm remote access from a second device.

## Operational boundary

Hosted mode is appropriate for database-backed workflows, file parsing, reports, email drafts, shipment updates, and PDF output. A desktop worker remains preferable for carrier sites that require a persistent personal Chrome session, interactive login, MFA, or captcha completion.
