# AI provider & model configuration

Every AI call in the app runs through three env vars:

| var                  | default                          | meaning                                            |
| -------------------- | -------------------------------- | -------------------------------------------------- |
| `AI_PROVIDER`        | `anthropic`                      | `anthropic` or `gemini` — picks which API to hit   |
| `AI_MODEL`           | `claude-haiku-4-5-20251001`      | primary model                                      |
| `AI_MODEL_FALLBACK`  | `claude-sonnet-4-6`              | retry model (used only when math validator fails)  |

Plus the matching API key — `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`.

## Why two models?

Most rate-sheet / email extractions are clean — Haiku 4.5 nails them
on the first pass at ~$0.01 / call. Maybe 5–15% of dense PDFs trip up
the cheap model: a discount line gets dropped, a per-container amount
isn't multiplied, etc. The math validator
([validateExtraction.ts](validateExtraction.ts)) catches those cases
and re-runs ONLY the failing call against the stronger fallback model.

That gives you Sonnet/Opus accuracy on the hard 5–15%, paying Haiku
prices on the clean 85–95%.

## Cost cheatsheet (typical 5K-input / 1K-output extraction)

| AI_MODEL                       | Provider     | Per-call (in/out)        | Vision | Notes                                                |
| ------------------------------ | ------------ | ------------------------ | ------ | ---------------------------------------------------- |
| `claude-opus-4-7`              | anthropic    | ~$0.075                  | ★★★★   | Best quality. Reserve for fallback / rare hard docs. |
| `claude-sonnet-4-6`            | anthropic    | ~$0.030                  | ★★★★   | Old default. Solid on everything.                    |
| `claude-haiku-4-5-20251001`    | anthropic    | ~$0.010                  | ★★★    | **Current default.** Vision strong, ~3× cheaper.     |
| `gemini-1.5-pro`               | gemini       | ~$0.012                  | ★★★★   | Excellent on PDF tables. Tool-use mature.            |
| `gemini-2.0-flash`             | gemini       | ~$0.001                  | ★★★    | **30× cheaper than Sonnet.** Fast, vision capable.   |
| `gemini-1.5-flash`             | gemini       | ~$0.0007                 | ★★★    | Same family, slightly older.                         |

## Recommended budgets

- **$0.01–$0.03 / call, $0.30–1.50 / day:** keep defaults.
  `AI_MODEL=claude-haiku-4-5-20251001`,
  `AI_MODEL_FALLBACK=claude-sonnet-4-6`.
- **$0.001–$0.005 / call, < $0.30 / day:**
  `AI_PROVIDER=gemini`, `AI_MODEL=gemini-2.0-flash`,
  `AI_MODEL_FALLBACK=gemini-1.5-pro`.
  Set `GEMINI_API_KEY=...`.
- **Best quality regardless:** `AI_MODEL=claude-opus-4-7`,
  `AI_MODEL_FALLBACK=claude-opus-4-7` (no fallback retry).

To disable the fallback (single-pass, never retry on validation
errors), set `AI_MODEL_FALLBACK` equal to `AI_MODEL`.

## What about DeepSeek / Grok / GPT?

Skipped intentionally:
- **DeepSeek V3** — text-strong but vision is weaker than even Haiku.
  Most of this app's value is reading PDFs and screenshots, so the
  cheaper text model would silently produce worse extractions.
- **Grok** — vision is OK but pricing is similar to Sonnet without
  matching quality. No upside.
- **GPT-4o / 4o-mini** — `4o-mini` is competitive with Gemini Flash
  on price; `4o` is more expensive than Sonnet for similar quality.
  Adding an OpenAI adapter is straightforward (same shape as
  `geminiAdapter.ts`) but isn't pulling its weight relative to Gemini
  on the cost / quality plane. Easy to add later if a workload turns
  up where it actually wins.

## Where the routing lives

- [model.ts](model.ts) — single source of truth for provider + model + fallback
- [geminiAdapter.ts](geminiAdapter.ts) — Anthropic-shaped wrapper for Google's API
- [validateExtraction.ts](validateExtraction.ts) — math-validation + retry trigger
- [parseShipmentBriefing.ts](parseShipmentBriefing.ts) and [parseDrayageRates.ts](parseDrayageRates.ts) — call sites that route through the layer above
