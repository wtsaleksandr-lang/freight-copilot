# freight-copilot

Local CLI that retrieves and ranks ocean freight rates from carrier portals, starting with Maersk.
Single-user, runs on your own machine, uses your existing portal logins.

## Status

V1 in progress — scaffolding only so far.

## Usage (planned)

```
freight-copilot maersk login              # one-time headed login, saves session
freight-copilot quote --from CNSHA --to NLRTM --container 40HC --date 2026-05-05
freight-copilot history                   # last 20 quotes
freight-copilot show <quote_id>           # full breakdown of a past quote
```
