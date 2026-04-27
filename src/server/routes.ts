import type { Express, Request, Response } from 'express';
import { desc, eq } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import {
  quotes,
  rateSnapshots,
  carriers as carriersTable,
  sessions as sessionsTable,
} from '../db/schema.js';
import { getCarrier, listCarriers } from '../carriers/registry.js';
import { parseRates } from '../llm/parseRates.js';
import { rankRates } from '../ranker/rankRates.js';
import { persistQuote } from '../db/persistQuote.js';
import { parseIntake, type IntakeInput } from '../llm/parseIntake.js';
import { generateClientReply, generateBundleReply } from '../llm/generateReply.js';
import type { RankedRateOption } from '../types.js';
import { runQuoteBundle, saveGeneratedEmail } from '../db/runBundle.js';
import {
  quoteBundles,
  drayageQuotes,
  drayageRates,
  truckingQuotes,
  truckingRates,
} from '../db/schema.js';
import { runDrayageQuote } from '../db/runDrayageQuote.js';
import { runTruckingQuote } from '../db/runTruckingQuote.js';
import { parseDrayageIntake } from '../llm/parseDrayageIntake.js';
import { CONTAINER_TYPES } from '../data/containerTypes.js';
import { MAJOR_PORTS } from '../data/ports.js';
import { SPECIAL_EQUIPMENT, ACCESSORIALS } from '../data/drayageOptions.js';
import { renderQuotePdf } from './pdf.js';
import { runAgent } from '../agent/runAgent.js';
import {
  startRecording,
  getRecording,
  listRecordings,
  stopRecording,
  readRecordingFile,
} from './recordingService.js';
import { analyzeRecording } from '../llm/analyzeRecording.js';

interface QuoteReqBody {
  carrier?: string;
  from?: string;
  fromRegion?: string;
  to?: string;
  toRegion?: string;
  container?: string;
  weight?: number | string;
  commodity?: string;
  cargoType?: 'general' | 'hazmat' | 'high_value' | 'reefer';
  originStruct?: import('../db/runBundle.js').BundleEnd;
  destinationStruct?: import('../db/runBundle.js').BundleEnd;
}

function csvEscape(v: string): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function registerApiRoutes(app: Express): void {
  /**
   * Lookup data for the dashboard form selectors.
   * Called once on dashboard load.
   */
  app.get('/api/data/lookups', async (_req: Request, res: Response) => {
    const db = createDbClient();

    // Recent unique addresses from past drayage + trucking + ocean quotes
    // for the address auto-suggest datalist.
    const dr = await db
      .select({
        a1: drayageQuotes.originAddressLine1,
        a2: drayageQuotes.destinationAddressLine1,
      })
      .from(drayageQuotes)
      .orderBy(desc(drayageQuotes.createdAt))
      .limit(50);
    const tr = await db
      .select({
        a1: truckingQuotes.pickupAddressLine1,
        a2: truckingQuotes.deliveryAddressLine1,
      })
      .from(truckingQuotes)
      .orderBy(desc(truckingQuotes.createdAt))
      .limit(50);

    const addressSet = new Set<string>();
    for (const r of [...dr, ...tr]) {
      if (r.a1) addressSet.add(r.a1);
      if (r.a2) addressSet.add(r.a2);
    }

    res.json({
      containerTypes: CONTAINER_TYPES,
      ports: MAJOR_PORTS,
      drayageSpecialEquipment: SPECIAL_EQUIPMENT,
      drayageAccessorials: ACCESSORIALS,
      recentAddresses: Array.from(addressSet).slice(0, 100),
    });
  });

  /**
   * Address autosuggest via OpenStreetMap Nominatim. Free, no API key.
   * Proxied through our server so we can attach a proper User-Agent and
   * (later) cache responses if needed.
   *
   * Returns a normalized list: [{ display, street, city, state, zip, country }]
   * Frontend debounces input.
   */
  app.get('/api/data/geocode', async (req: Request, res: Response) => {
    const rawQ = req.query.q;
    const q = typeof rawQ === 'string' ? rawQ.trim() : '';
    if (q.length < 3) {
      res.json({ results: [] });
      return;
    }
    try {
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.searchParams.set('format', 'json');
      url.searchParams.set('addressdetails', '1');
      url.searchParams.set('limit', '8');
      // Restrict to US + Canada per user request. Using a free-form `q=` for
      // all queries (including bare ZIPs) — Nominatim's `countrycodes` filter
      // is reliably honored on `q=`, but is bypassed when using the structured
      // `postalcode=` parameter.
      url.searchParams.set('countrycodes', 'us,ca');
      url.searchParams.set('q', q);
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'freight-copilot/1.0 (personal-use freight forwarder app)',
          Accept: 'application/json',
        },
      });
      if (!r.ok) {
        res.status(502).json({ error: `Nominatim returned ${r.status}` });
        return;
      }
      const raw = (await r.json()) as Array<{
        display_name: string;
        address?: Record<string, string | undefined>;
      }>;
      const results = raw.map((it) => {
        const a = it.address ?? {};
        const street = [a.house_number, a.road].filter(Boolean).join(' ').trim();
        const city =
          a.city ?? a.town ?? a.village ?? a.hamlet ?? a.municipality ?? '';
        return {
          display: it.display_name,
          street,
          city,
          state: a.state ?? a.region ?? '',
          zip: a.postcode ?? '',
          country: a.country ?? '',
          countryCode: (a.country_code ?? '').toUpperCase(),
        };
      });
      res.json({ results });
    } catch (err) {
      console.error('[api/data/geocode] error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/carriers', async (_req: Request, res: Response) => {
    // Source of truth is the registry (code/name/isActive live with the adapters).
    const rows = listCarriers().map((c) => ({
      code: c.code,
      name: c.name,
      homeUrl: c.homeUrl,
      isActive: c.isActive,
    }));
    res.json({ carriers: rows });
  });

  app.get('/api/sessions', async (_req: Request, res: Response) => {
    const db = createDbClient();
    const carrierRows = await db.select().from(carriersTable);
    const sessionRows = await db.select().from(sessionsTable);
    const now = Date.now();

    const summary = listCarriers().map((c) => {
      const dbCarrier = carrierRows.find((r) => r.code === c.code);
      const session = dbCarrier
        ? sessionRows.find((s) => s.carrierId === dbCarrier.id)
        : undefined;

      if (!session) {
        return {
          carrierCode: c.code,
          carrierName: c.name,
          exists: false,
          status: 'missing' as const,
          daysLeft: null as number | null,
          expiresAt: null as string | null,
        };
      }
      const expiresAtMs = session.expiresAt.getTime();
      const daysLeft = Math.floor((expiresAtMs - now) / (24 * 60 * 60 * 1000));
      let status: 'fresh' | 'expiring' | 'expired';
      if (daysLeft <= 0) status = 'expired';
      else if (daysLeft <= 2) status = 'expiring';
      else status = 'fresh';

      return {
        carrierCode: c.code,
        carrierName: c.name,
        exists: true,
        status,
        daysLeft,
        expiresAt: session.expiresAt.toISOString(),
      };
    });

    res.json({ sessions: summary });
  });

  app.get('/api/quotes', async (_req: Request, res: Response) => {
    const db = createDbClient();
    const rows = await db
      .select()
      .from(quotes)
      .orderBy(desc(quotes.createdAt))
      .limit(50);
    res.json({ quotes: rows });
  });

  app.get('/api/quotes.csv', async (_req: Request, res: Response) => {
    const db = createDbClient();
    const rows = await db
      .select({
        qid: quotes.id,
        created: quotes.createdAt,
        origin: quotes.origin,
        destination: quotes.destination,
        containerType: quotes.containerType,
        requestedDate: quotes.requestedDate,
        carrierCode: carriersTable.code,
        rank: rateSnapshots.rank,
        serviceName: rateSnapshots.serviceName,
        sailingDate: rateSnapshots.sailingDate,
        transitDays: rateSnapshots.transitDays,
        currency: rateSnapshots.currency,
        totalCents: rateSnapshots.totalCostCents,
      })
      .from(quotes)
      .leftJoin(rateSnapshots, eq(rateSnapshots.quoteId, quotes.id))
      .leftJoin(carriersTable, eq(carriersTable.id, rateSnapshots.carrierId))
      .orderBy(desc(quotes.createdAt), rateSnapshots.rank);

    const headers = [
      'quote_id',
      'created_at',
      'carrier',
      'origin',
      'destination',
      'container',
      'requested_date',
      'rank',
      'service',
      'sailing_date',
      'transit_days',
      'currency',
      'total_cost',
    ];
    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.qid,
          r.created.toISOString(),
          r.carrierCode ?? '',
          csvEscape(r.origin),
          csvEscape(r.destination),
          csvEscape(r.containerType),
          r.requestedDate,
          r.rank ?? '',
          csvEscape(r.serviceName ?? ''),
          csvEscape(r.sailingDate ?? ''),
          r.transitDays ?? '',
          r.currency ?? '',
          r.totalCents != null ? (r.totalCents / 100).toFixed(2) : '',
        ].join(',')
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="freight-copilot-quotes-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    res.send(lines.join('\r\n'));
  });

  app.get('/api/quotes/:id/pdf', async (req: Request, res: Response) => {
    const db = createDbClient();
    const rawId = req.params.id;
    const id = parseInt(
      Array.isArray(rawId) ? (rawId[0] ?? '') : (rawId ?? ''),
      10
    );
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }

    const [quote] = await db.select().from(quotes).where(eq(quotes.id, id));
    if (!quote) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }

    const snaps = await db
      .select({
        rank: rateSnapshots.rank,
        serviceName: rateSnapshots.serviceName,
        sailingDate: rateSnapshots.sailingDate,
        vesselVoyage: rateSnapshots.vesselVoyage,
        transitDays: rateSnapshots.transitDays,
        detentionFreetimeDays: rateSnapshots.detentionFreetimeDays,
        demurrageFreetimeDays: rateSnapshots.demurrageFreetimeDays,
        rollable: rateSnapshots.rollable,
        currency: rateSnapshots.currency,
        totalCostCents: rateSnapshots.totalCostCents,
        charges: rateSnapshots.charges,
        destinationCharges: rateSnapshots.destinationCharges,
        destinationTotal: rateSnapshots.destinationTotal,
        destinationCurrency: rateSnapshots.destinationCurrency,
        carrierCode: carriersTable.code,
        carrierName: carriersTable.name,
      })
      .from(rateSnapshots)
      .leftJoin(carriersTable, eq(carriersTable.id, rateSnapshots.carrierId))
      .where(eq(rateSnapshots.quoteId, id))
      .orderBy(rateSnapshots.rank);

    const carrierCode = snaps[0]?.carrierCode ?? '—';
    const carrierName = snaps[0]?.carrierName ?? '—';
    const pct = parseFloat(String(req.query.pct ?? '0')) || 0;
    const flat = parseFloat(String(req.query.flat ?? '0')) || 0;

    try {
      const pdf = await renderQuotePdf(
        {
          id: quote.id,
          carrierCode,
          carrierName,
          origin: quote.origin,
          destination: quote.destination,
          containerType: quote.containerType,
          requestedDate: quote.requestedDate,
          createdAt: quote.createdAt,
          notes: quote.notes,
          rates: snaps.map((s) => ({
            rank: s.rank,
            serviceName: s.serviceName ?? '—',
            sailingDate: s.sailingDate,
            vesselVoyage: s.vesselVoyage,
            transitDays: s.transitDays,
            detentionFreetimeDays: s.detentionFreetimeDays,
            demurrageFreetimeDays: s.demurrageFreetimeDays,
            rollable: s.rollable,
            currency: s.currency,
            totalCostCents: s.totalCostCents,
            freightCharges: (s.charges ?? []).map((c) => ({
              name: c.name,
              total: c.total,
              currency: c.currency,
            })),
            destinationCharges: (s.destinationCharges ?? []).map((c) => ({
              name: c.name,
              total: c.total,
              currency: c.currency,
            })),
            destinationTotal: s.destinationTotal,
            destinationCurrency: s.destinationCurrency,
          })),
        },
        { pct, flat }
      );
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="quote-${quote.id}-${quote.origin}-${quote.destination}.pdf"`
      );
      res.send(pdf);
    } catch (err) {
      console.error('[api/quotes/:id/pdf] error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/quotes/:id', async (req: Request, res: Response) => {
    const db = createDbClient();
    const rawId = req.params.id;
    const id = parseInt(Array.isArray(rawId) ? (rawId[0] ?? '') : (rawId ?? ''), 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const [quote] = await db.select().from(quotes).where(eq(quotes.id, id));
    if (!quote) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    const snaps = await db
      .select()
      .from(rateSnapshots)
      .where(eq(rateSnapshots.quoteId, id))
      .orderBy(rateSnapshots.rank);
    res.json({ quote, rateSnapshots: snaps });
  });

  app.post('/api/quote', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as QuoteReqBody;
    const { carrier: carrierCodeRaw, from, fromRegion, to, toRegion, container, weight, commodity } = body;
    if (!from || !to || !container || weight == null) {
      res.status(400).json({
        error: 'Missing required fields: from, to, container, weight',
      });
      return;
    }

    try {
      const carrierCode = carrierCodeRaw ?? 'MSK';
      let carrier;
      try {
        carrier = getCarrier(carrierCode);
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (!carrier.isActive) {
        res.status(400).json({
          error: `${carrier.name} (${carrier.code}) is not yet onboarded. See docs/onboarding-checklist.md.`,
        });
        return;
      }

      console.log(
        `[api/quote] ${carrier.code} ${from} -> ${to}, ${container}, ${weight}kg`
      );
      const fetchResult = await carrier.fetchRates({
        origin: from,
        originRegion: fromRegion,
        destination: to,
        destinationRegion: toRegion,
        containerType: container,
        cargoWeightKg:
          typeof weight === 'number' ? weight : parseInt(String(weight), 10),
        commodity,
      });

      const rates = await parseRates(fetchResult.sailingsAriaTree);
      const ranked = rankRates(rates);

      const today = new Date().toISOString().slice(0, 10);
      const quoteId = await persistQuote({
        origin: from,
        destination: to,
        containerType: container,
        requestedDate: today,
        carrierCode: carrier.code,
        ranked,
        rawHtmlRef: fetchResult.htmlPath,
      });

      res.json({
        quoteId,
        ranked,
        artifacts: {
          html: fetchResult.htmlPath,
          ariaTree: fetchResult.ariaTreePath,
          screenshot: fetchResult.screenshotPath,
        },
      });
    } catch (err) {
      console.error('[api/quote] error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Intake: paste client request (text or image) -> structured quote fields.
  app.post('/api/intake', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      text?: string;
      imageBase64?: string;
      imageMediaType?: IntakeInput extends { imageMediaType: infer T } ? T : never;
    };
    try {
      let input: IntakeInput;
      if (body.text && body.text.trim().length > 0) {
        input = { text: body.text };
      } else if (body.imageBase64 && body.imageMediaType) {
        input = {
          imageBase64: body.imageBase64,
          imageMediaType: body.imageMediaType,
        };
      } else {
        res.status(400).json({
          error:
            'Provide either `text` (non-empty string) or `imageBase64` + `imageMediaType`.',
        });
        return;
      }

      const result = await parseIntake(input);
      res.json(result);
    } catch (err) {
      console.error('[api/intake] error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---- Quote bundles (one-click multi-carrier flow) ----

  app.post('/api/bundle/run', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      carriers?: string[];
      from?: string;
      fromRegion?: string;
      to?: string;
      toRegion?: string;
      container?: string;
      weight?: number | string;
      commodity?: string;
      cargoType?: 'general' | 'hazmat' | 'high_value' | 'reefer';
      originStruct?: import('../db/runBundle.js').BundleEnd;
      destinationStruct?: import('../db/runBundle.js').BundleEnd;
      clientName?: string;
      markupPct?: number | string;
      markupFlat?: number | string;
      emailTemplate?: string;
      intakeText?: string;
    };

    const carriers = Array.isArray(body.carriers) ? body.carriers : [];
    if (carriers.length === 0) {
      res.status(400).json({ error: 'Pick at least one carrier.' });
      return;
    }
    if (!body.from || !body.to || !body.container || body.weight == null) {
      res.status(400).json({
        error: 'Missing required fields: from, to, container, weight',
      });
      return;
    }

    try {
      const bundle = await runQuoteBundle({
        carrierCodes: carriers,
        origin: body.from,
        originRegion: body.fromRegion,
        destination: body.to,
        destinationRegion: body.toRegion,
        cargoType: body.cargoType,
        originStruct: body.originStruct,
        destinationStruct: body.destinationStruct,
        containerType: body.container,
        cargoWeightKg:
          typeof body.weight === 'number'
            ? body.weight
            : parseInt(String(body.weight), 10),
        commodity: body.commodity,
        clientName: body.clientName,
        markupPct: Number(body.markupPct ?? 0),
        markupFlat: Number(body.markupFlat ?? 0),
        emailTemplate: body.emailTemplate,
        intakeText: body.intakeText,
      });

      // Generate email if any carrier returned rates
      let generatedEmail = '';
      if (bundle.carriers.some((c) => c.status === 'ok' && c.ranked.length > 0)) {
        try {
          generatedEmail = await generateBundleReply({
            clientName: body.clientName,
            origin: body.from,
            destination: body.to,
            containerType: body.container,
            cargoWeightKg:
              typeof body.weight === 'number'
                ? body.weight
                : parseInt(String(body.weight), 10),
            commodity: body.commodity,
            markupPct: Number(body.markupPct ?? 0),
            markupFlat: Number(body.markupFlat ?? 0),
            emailTemplate: body.emailTemplate,
            carriers: bundle.carriers,
          });
          await saveGeneratedEmail(
            bundle.bundleId,
            bundle.refId,
            bundle.outputFolder,
            generatedEmail
          );
        } catch (err) {
          console.error('[api/bundle/run] email gen failed:', err);
        }
      }

      res.json({ ...bundle, generatedEmail });
    } catch (err) {
      console.error('[api/bundle/run] error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/bundles', async (_req: Request, res: Response) => {
    const db = createDbClient();
    const rows = await db
      .select()
      .from(quoteBundles)
      .orderBy(desc(quoteBundles.createdAt))
      .limit(50);
    res.json({ bundles: rows });
  });

  app.get('/api/bundles/:refId', async (req: Request, res: Response) => {
    const db = createDbClient();
    const rawRefId = req.params.refId;
    const refId = Array.isArray(rawRefId) ? rawRefId[0] : rawRefId;
    if (!refId) {
      res.status(400).json({ error: 'Invalid refId' });
      return;
    }
    const [bundle] = await db
      .select()
      .from(quoteBundles)
      .where(eq(quoteBundles.refId, refId));
    if (!bundle) {
      res.status(404).json({ error: 'Bundle not found' });
      return;
    }
    // Fetch all rate snapshots across all child quotes of this bundle
    const childQuotes = await db
      .select()
      .from(quotes)
      .where(eq(quotes.bundleId, bundle.id));
    const snaps =
      childQuotes.length > 0
        ? await db
            .select({
              quoteId: rateSnapshots.quoteId,
              rank: rateSnapshots.rank,
              serviceName: rateSnapshots.serviceName,
              sailingDate: rateSnapshots.sailingDate,
              vesselVoyage: rateSnapshots.vesselVoyage,
              transitDays: rateSnapshots.transitDays,
              detentionFreetimeDays: rateSnapshots.detentionFreetimeDays,
              demurrageFreetimeDays: rateSnapshots.demurrageFreetimeDays,
              rollable: rateSnapshots.rollable,
              currency: rateSnapshots.currency,
              totalCostCents: rateSnapshots.totalCostCents,
              charges: rateSnapshots.charges,
              destinationCharges: rateSnapshots.destinationCharges,
              destinationTotal: rateSnapshots.destinationTotal,
              destinationCurrency: rateSnapshots.destinationCurrency,
              carrierCode: carriersTable.code,
              carrierName: carriersTable.name,
            })
            .from(rateSnapshots)
            .leftJoin(
              carriersTable,
              eq(carriersTable.id, rateSnapshots.carrierId)
            )
            .where(eq(rateSnapshots.quoteId, childQuotes[0]!.id)) // simplified for V1
        : [];
    res.json({ bundle, rateSnapshots: snaps });
  });

  // ---- Drayage (port ↔ address container moves) ----

  app.post('/api/drayage/quote', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!body.cargoType || !body.containerType || !body.origin || !body.destination) {
      res.status(400).json({
        error:
          'Missing required fields: cargoType, containerType, origin{type,...}, destination{type,...}',
      });
      return;
    }
    try {
      const result = await runDrayageQuote(
        body as unknown as Parameters<typeof runDrayageQuote>[0]
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/drayage/intake', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      text?: string;
      imageBase64?: string;
      imageMediaType?: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    };
    try {
      let result;
      if (body.text && body.text.trim().length > 0) {
        result = await parseDrayageIntake({ text: body.text });
      } else if (body.imageBase64 && body.imageMediaType) {
        result = await parseDrayageIntake({
          imageBase64: body.imageBase64,
          imageMediaType: body.imageMediaType,
        });
      } else {
        res.status(400).json({
          error: 'Provide either `text` or `imageBase64` + `imageMediaType`.',
        });
        return;
      }
      res.json(result);
    } catch (err) {
      console.error('[api/drayage/intake] error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Run the rate-retrieval automation for a saved drayage request.
   *
   * V1: stub — there are no providers wired in yet. When you record a
   * drayage workflow (Record tab → drayage carrier portal) and we activate
   * a replay engine, this endpoint will spawn the recorded automation
   * with the saved request's fields as parameters.
   */
  app.post('/api/drayage/run/:refId', async (req: Request, res: Response) => {
    const rawId = req.params.refId;
    const refId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!refId) {
      res.status(400).json({ error: 'Invalid refId' });
      return;
    }
    const db = createDbClient();
    const [quote] = await db
      .select()
      .from(drayageQuotes)
      .where(eq(drayageQuotes.refId, refId));
    if (!quote) {
      res.status(404).json({ error: 'Drayage request not found' });
      return;
    }
    res.status(200).json({
      refId,
      status: 'no_automation_configured',
      message:
        'No drayage provider workflows are recorded yet. Use the Record tab to capture one for a specific provider, then come back — the Run button will replay the recording with this request\'s fields.',
    });
  });

  app.get('/api/drayage/quotes', async (_req: Request, res: Response) => {
    const db = createDbClient();
    const rows = await db
      .select()
      .from(drayageQuotes)
      .orderBy(desc(drayageQuotes.createdAt))
      .limit(50);
    res.json({ quotes: rows });
  });

  app.get('/api/drayage/quotes/:refId', async (req: Request, res: Response) => {
    const db = createDbClient();
    const rawId = req.params.refId;
    const refId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!refId) {
      res.status(400).json({ error: 'Invalid refId' });
      return;
    }
    const [quote] = await db
      .select()
      .from(drayageQuotes)
      .where(eq(drayageQuotes.refId, refId));
    if (!quote) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    const rates = await db
      .select()
      .from(drayageRates)
      .where(eq(drayageRates.drayageQuoteId, quote.id))
      .orderBy(drayageRates.rank);
    res.json({ quote, rates });
  });

  // ---- Trucking (FTL/LTL dryvan, flatbed, reefer, etc.) ----

  app.post('/api/trucking/quote', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      !body.pickupAddressLine1 ||
      !body.pickupCity ||
      !body.deliveryAddressLine1 ||
      !body.deliveryCity ||
      !body.equipmentType
    ) {
      res.status(400).json({
        error:
          'Missing required fields: pickup address+city, delivery address+city, equipmentType',
      });
      return;
    }
    try {
      const result = await runTruckingQuote(
        body as unknown as Parameters<typeof runTruckingQuote>[0]
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/trucking/quotes', async (_req: Request, res: Response) => {
    const db = createDbClient();
    const rows = await db
      .select()
      .from(truckingQuotes)
      .orderBy(desc(truckingQuotes.createdAt))
      .limit(50);
    res.json({ quotes: rows });
  });

  app.get('/api/trucking/quotes/:refId', async (req: Request, res: Response) => {
    const db = createDbClient();
    const rawId = req.params.refId;
    const refId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!refId) {
      res.status(400).json({ error: 'Invalid refId' });
      return;
    }
    const [quote] = await db
      .select()
      .from(truckingQuotes)
      .where(eq(truckingQuotes.refId, refId));
    if (!quote) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    const rates = await db
      .select()
      .from(truckingRates)
      .where(eq(truckingRates.truckingQuoteId, quote.id))
      .orderBy(truckingRates.rank);
    res.json({ quote, rates });
  });

  // ---- Recording (one-click in-dashboard workflow capture) ----

  app.post('/api/record/start', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      url?: string;
      carrierCode?: string;
      description?: string;
    };
    if (!body.url) {
      res.status(400).json({ error: '`url` is required.' });
      return;
    }
    try {
      const meta = await startRecording({
        url: body.url,
        carrierCode: body.carrierCode,
        description: body.description,
      });
      res.json(meta);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/record/status/:id', (req: Request, res: Response) => {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const meta = getRecording(id);
    if (!meta) {
      res.status(404).json({ error: 'Recording not found.' });
      return;
    }
    res.json(meta);
  });

  app.post('/api/record/stop/:id', (req: Request, res: Response) => {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const ok = stopRecording(id);
    res.json({ ok });
  });

  app.post('/api/record/analyze/:id', async (req: Request, res: Response) => {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const meta = getRecording(id);
    if (!meta) {
      res.status(404).json({ error: 'Recording not found.' });
      return;
    }
    if (meta.status === 'running') {
      res.status(400).json({
        error: 'Recording is still running — close the browser window first.',
      });
      return;
    }
    try {
      const code = await readRecordingFile(id);
      if (!code.trim()) {
        res.status(400).json({
          error: 'Recording file is empty. The browser may have been closed before any actions were captured.',
        });
        return;
      }
      const analysis = await analyzeRecording({
        recordingPath: meta.outFile,
        recordingCode: code,
        url: meta.url,
        carrierCode: meta.carrierCode,
        description: meta.description,
      });
      res.json({ meta, analysis });
    } catch (err) {
      console.error('[api/record/analyze] error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/record/list', (_req: Request, res: Response) => {
    res.json({ recordings: listRecordings() });
  });

  // Generic web agent — Claude drives a browser to complete a goal on any site.
  app.post('/api/agent', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      url?: string;
      goal?: string;
      maxIterations?: number;
    };
    if (!body.url || !body.goal) {
      res.status(400).json({ error: 'Provide `url` and `goal`.' });
      return;
    }
    if (!/^https?:\/\//i.test(body.url)) {
      res.status(400).json({ error: 'URL must start with http:// or https://' });
      return;
    }
    try {
      const result = await runAgent({
        url: body.url,
        goal: body.goal,
        maxIterations: body.maxIterations ?? 25,
      });
      res.json(result);
    } catch (err) {
      console.error('[api/agent] error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Generate a client-ready quote reply from the ranked rates.
  app.post('/api/reply', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      origin?: string;
      destination?: string;
      containerType?: string;
      ranked?: RankedRateOption[];
    };
    if (
      !body.origin ||
      !body.destination ||
      !body.containerType ||
      !Array.isArray(body.ranked) ||
      body.ranked.length === 0
    ) {
      res.status(400).json({
        error:
          'Missing required fields: origin, destination, containerType, and a non-empty ranked array.',
      });
      return;
    }
    try {
      const text = await generateClientReply({
        origin: body.origin,
        destination: body.destination,
        containerType: body.containerType,
        ranked: body.ranked,
      });
      res.json({ text });
    } catch (err) {
      console.error('[api/reply] error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
