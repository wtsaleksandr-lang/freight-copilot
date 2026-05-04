# Freight Copilot

A local CLI + web dashboard that retrieves and ranks ocean freight rates from carrier portals (Maersk, MSC, CMA CGM, Hapag-Lloyd, ONE Line, OOCL, ZIM).

## Architecture

- **Runtime**: Node.js 20, TypeScript (ESM), pnpm
- **Web server**: Express 5 serving a static SPA dashboard at port 5000
- **Database**: SQLite via Drizzle ORM + libsql client (`./data/freight-copilot.db`)
- **LLM**: Anthropic Claude (via `@anthropic-ai/sdk`) for parsing rate sheets and generating emails
- **Browser automation**: Playwright for carrier portal scraping
- **CLI**: commander — subcommands: `serve`, `quote`, `parse`, `history`, `agent`, `record`, `login`

## Project Structure

```
src/
  index.ts          — CLI entry point (commander)
  config.ts         — Zod env validation (ANTHROPIC_API_KEY required)
  cli/              — CLI command registrations
    serveCmd.ts     — starts Express dashboard
    quoteCmd.ts     — fetch/parse/rank/persist quotes
    parseCmd.ts     — offline rate sheet parsing
    historyCmd.ts   — quote history commands
    agentCmd.ts     — web agent command
    recordCmd.ts    — session recording
    loginCmd.ts     — Maersk login commands
  server/
    app.ts          — Express app factory (Basic auth, static files, keep-alive pinger)
    routes.ts       — API routes
    public/         — Static SPA (index.html, style.css, app.js, favicon.svg)
  db/
    schema.ts       — Drizzle schema (carriers, quote_bundles, rates, shipments, etc.)
    client.ts       — DB client factory
    seed.ts         — Seeds carrier rows
    persistQuote.ts — Quote persistence logic
  carriers/         — Per-carrier Playwright adapters (maersk, msc, cma, hlc, one, oocl, zim)
  llm/              — Claude-powered parsing (rates, intake, email generation)
  ranker/           — Rate ranking logic
  agent/            — Web agent (Claude + Playwright tools)
  captcha/          — Captcha detection/solving helpers
tampermonkey/       — Browser userscript for portal data capture
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | — | Claude API key |
| `DATABASE_FILE` | No | `./data/freight-copilot.db` | SQLite DB path |
| `USE_REAL_CHROME` | No | `false` | Use real Chrome (CDP) instead of Playwright Chromium |
| `BASIC_AUTH_USER` | No | — | Enable HTTP Basic auth (set both user+pass) |
| `BASIC_AUTH_PASS` | No | — | Enable HTTP Basic auth |
| `DELAYPREDICT_URL` | No | — | DelayPredict integration base URL |

## Workflow

**Start application**: `pnpm tsx src/index.ts serve --port 5000 --host 0.0.0.0`

Runs the Express dashboard on port 5000, bound to all interfaces for Replit's proxy.

## Database Setup

Schema is managed by Drizzle Kit:
- `pnpm db:push` — push schema changes to the SQLite file
- `pnpm tsx src/db/seed.ts` — seed carrier rows (run once after first push)

## Key Notes

- The app requires `ANTHROPIC_API_KEY` at startup — it will exit with an error if missing
- SQLite database is created automatically at `./data/freight-copilot.db` on first `db:push`
- `USE_REAL_CHROME=false` uses Playwright's bundled Chromium (no extra setup needed)
- The dashboard is a vanilla JS SPA served as static files — no build step needed for frontend
