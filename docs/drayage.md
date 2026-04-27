# Drayage quotes

## Scope

The drayage tab handles **port ↔ address container truck moves**:
- **Import drayage:** ocean container arrives at a port → trucked to a consignee's facility.
- **Export drayage:** loaded container picked up at a shipper's facility → delivered to a port for ocean export.

It does NOT handle the ocean leg (that's the Ocean tab) or general non-container trucking (that's the Trucking tab).

## What's built today (foundation)

- DB tables: `drayage_quotes` + `drayage_rates`
- API: `POST /api/drayage/quote`, `GET /api/drayage/quotes`, `GET /api/drayage/quotes/:refId`
- Dashboard tab with the full input form
- Per-request folder: `quotes/drayage/D-YYYYMMDD-XXXX/request.json`
- Reference IDs: `D-YYYYMMDD-XXXX`

## What's NOT built (waiting on rate data)

- Provider integrations. The runner currently saves the request and returns `status: pending_rate_sources`.
- When you have a way to source drayage rates we'll wire it in. Common options:
  - **Carrier inland portals** (Maersk Inland, MSC Inland, Hapag inland) — drives via Playwright like the ocean adapters.
  - **Provider rate sheets** (Excel, PDF, email attachments from local truckers) — Claude parses, persists.
  - **Drayage marketplaces / APIs** (Drayage.com, Loadsmart Drayage, OpenTrack) — API-based.
  - **Manual entry** — quick form to type in a rate, useful for one-off provider quotes.

## Adding a rate source (when you're ready)

`src/db/runDrayageQuote.ts` exposes `recordDrayageRates(quoteId, rates[])`. Call it from your provider integration to persist results. Each rate row carries:
- providerName, providerCode
- itemized charges (line-haul, fuel surcharge, chassis, etc.)
- baseRate + totalCost (USD by default)
- transit days, validity, free-time days
- a path back to the source document/screenshot/PDF

Then update the dashboard to show the rates (today the result card just shows the saved request — once `recordDrayageRates` populates rows, fetch them via the detail endpoint and render).

## Fields captured

- **Direction** (import / export)
- **Port** code (UN/LOCODE) and name
- **Address** (street, city, state, ZIP, country)
- **Container** type and count
- **Weight** (kg) — affects overweight permits
- **Pickup / delivery dates**
- **Special equipment** — tri-axle chassis, gen-set for reefer, hazmat, overweight permit, etc.
- **Accessorials** — prepull, storage, detention notes
- **Client name** (for the eventual quote reply)
- **Notes** — anything else relevant
