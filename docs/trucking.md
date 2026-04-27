# Trucking quotes

## Scope

Ground freight, **no ocean container** — domestic / cross-border road moves on dryvan, flatbed, reefer, step deck, conestoga, or hotshot. Both FTL (full truckload) and LTL (less than truckload).

For port ↔ address container moves, use the Drayage tab instead.

## What's built today (foundation)

- DB tables: `trucking_quotes` + `trucking_rates`
- API: `POST /api/trucking/quote`, `GET /api/trucking/quotes`, `GET /api/trucking/quotes/:refId`
- Dashboard tab with the full input form
- Per-request folder: `quotes/trucking/T-YYYYMMDD-XXXX/request.json`
- Reference IDs: `T-YYYYMMDD-XXXX`

## What's NOT built (waiting on rate data)

- Provider integrations. The runner saves the request and returns `status: pending_rate_sources`.
- Likely sources to wire in later:
  - **DAT** RateView / rate API (commercial subscription)
  - **Truckstop.com** rate API
  - **Internal rate sheets** (Excel/PDF from your contracted carriers) — Claude parses
  - **Broker portals** (Coyote, Convoy, Uber Freight, Loadsmart) — Playwright like ocean adapters
  - **Direct carrier quoting** — manual or API per carrier

## Fields captured

- **Mode**: FTL or LTL
- **Equipment**: dryvan, flatbed, reefer, step deck, conestoga, hotshot, other
- **Pickup**: street, city, state, ZIP, country
- **Delivery**: street, city, state, ZIP, country
- **Cargo**: weight (kg), pieces, length/width/height (ft), commodity
- **Flags**: hazmat, temperature controlled (with min/max °F for reefer)
- **Dates**: pickup / delivery
- **Client name**, notes

## Adding a rate source (when you're ready)

`src/db/runTruckingQuote.ts` exposes `recordTruckingRates(quoteId, rates[])`. Each rate carries:
- providerName, providerCode
- itemized charges (line-haul, fuel, accessorials)
- baseRate + totalCost
- transitDays, ratePerMile, totalMiles
- validity, raw source path

For LTL specifically, you'll want to extend the schema later with class/freight class, NMFC code, accessorial codes (residential, liftgate, inside delivery, appointment).
