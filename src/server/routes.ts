import type { Express, Request, Response } from 'express';
import { resolve } from 'node:path';
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
import {
  generateClientReply,
  generateBundleReply,
  generateSheetReply,
  type SheetReplyRow,
} from '../llm/generateReply.js';
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
  saveUploadedRecording,
} from './recordingService.js';
import { analyzeRecording } from '../llm/analyzeRecording.js';
import {
  listCredentials,
  upsertCredential,
  revealCredential,
  deleteCredential,
} from './credentialsService.js';
import { getBundleProgress } from './bundleProgress.js';
import {
  getCachedProbeResults,
  probeCarrierSession,
  probeAllCarriers,
} from './sessionProbe.js';
import {
  parseRateSheet,
  type RateSheetMediaType,
} from '../llm/parseRateSheet.js';
import {
  saveSheetUpload,
  updateSheetUploadEmail,
  searchSheetUploads,
  getSheetUploadDetail,
  ratesFromParsedResults,
} from '../db/sheetHistory.js';
import {
  listShipments,
  createShipment,
  updateShipment,
  deleteShipment,
  getShipment,
} from '../db/shipmentBoard.js';
import {
  parseShipmentBriefing,
  detectMediaType,
  type BriefingMediaType,
} from '../llm/parseShipmentBriefing.js';
import {
  getDelayPredictBadgeMap,
  refreshDelayPredictTracking,
} from './delayPredictClient.js';

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
    // Caller can pin a single country (us | ca). Default both for back-compat.
    const rawCountry = req.query.country;
    const country = typeof rawCountry === 'string' ? rawCountry.toLowerCase() : '';
    const allowed = ['us', 'ca'];
    const ccFilter = allowed.includes(country) ? country : 'us,ca';
    try {
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.searchParams.set('format', 'json');
      url.searchParams.set('addressdetails', '1');
      url.searchParams.set('limit', '8');
      url.searchParams.set('countrycodes', ccFilter);
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

  /**
   * Live session probe results from the keep-alive pinger. Each carrier
   * here has been visited recently in Real Chrome mode; the loggedIn
   * field reflects what the page actually showed (form vs. login redirect).
   * Use these in the dashboard's per-carrier badges when USE_REAL_CHROME=true.
   */
  app.get('/api/sessions/probe', (_req: Request, res: Response) => {
    res.json({ probes: getCachedProbeResults() });
  });

  /**
   * Trigger an on-demand probe (one carrier or all). Useful right after
   * the user logs in to a portal — they hit "Re-check" instead of waiting
   * for the next 10-min cycle.
   */
  app.post('/api/sessions/probe', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { carrierCode?: string };
    try {
      if (body.carrierCode) {
        const r = await probeCarrierSession(body.carrierCode);
        res.json({ probes: [r] });
      } else {
        const r = await probeAllCarriers();
        res.json({ probes: r });
      }
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
      refId?: string;
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
        refId: body.refId,
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

  app.get(
    '/api/bundle/:refId/progress',
    (req: Request, res: Response) => {
      const rawId = req.params.refId;
      const refId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!refId) {
        res.status(400).json({ error: 'refId is required' });
        return;
      }
      const entry = getBundleProgress(refId);
      if (!entry) {
        // 404 here is expected for the brief window before the bundle has
        // been seeded; the dashboard treats it as "still warming up".
        res.status(404).json({ error: 'Progress not found (yet)' });
        return;
      }
      res.json(entry);
    }
  );

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

  /**
   * Upload an existing recording file (Chrome DevTools Recorder JSON,
   * Playwright Codegen .ts, or Puppeteer .js). Saves it to disk, registers
   * it in the in-memory recordings list, and immediately runs Claude
   * analysis so the dashboard can render results in one round-trip.
   */
  app.post('/api/record/upload', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      content?: string;
      filename?: string;
      carrierCode?: string;
      description?: string;
    };
    if (!body.content || body.content.trim().length === 0) {
      res.status(400).json({ error: '`content` is required.' });
      return;
    }
    try {
      const meta = await saveUploadedRecording({
        content: body.content,
        filename: body.filename,
        carrierCode: body.carrierCode,
        description: body.description,
      });
      const analysis = await analyzeRecording({
        recordingPath: meta.outFile,
        recordingCode: body.content,
        url: meta.url,
        carrierCode: meta.carrierCode,
        description: meta.description,
      });
      res.json({ meta, analysis });
    } catch (err) {
      console.error('[api/record/upload] error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

  // ---- Rate-sheet parser (offline path: AI reads PDFs/screenshots) ----

  app.post('/api/rates/parse-sheet', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      files?: Array<{
        filename?: string;
        contentBase64: string;
        mediaType: RateSheetMediaType;
      }>;
    };
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0) {
      res.status(400).json({ error: 'No files provided.' });
      return;
    }

    // Group all files in this submission under one refId folder for audit.
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    const refId = `RS-${date}-${rand}`;
    const outDir = resolve('./parsed-sheets', refId);
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(outDir, { recursive: true });

    const results: Array<{
      filename: string;
      ok: boolean;
      reason?: string;
      parsed?: import('../llm/parseRateSheet.js').RateSheetResult;
      artifacts?: { source: string; parsed: string };
    }> = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const filename = f.filename ?? `sheet-${i + 1}`;
      const safe = filename.replace(/[^a-z0-9._-]/gi, '_');
      const ext =
        f.mediaType === 'application/pdf'
          ? 'pdf'
          : f.mediaType.split('/')[1] ?? 'bin';
      const sourcePath = resolve(outDir, `${i + 1}-${safe}`);
      const parsedPath = resolve(outDir, `${i + 1}-${safe}.parsed.json`);
      try {
        await writeFile(sourcePath, Buffer.from(f.contentBase64, 'base64'));
        const parsed = await parseRateSheet({
          fileBase64: f.contentBase64,
          mediaType: f.mediaType,
          filename,
        });
        await writeFile(parsedPath, JSON.stringify(parsed, null, 2));
        results.push({
          filename,
          ok: true,
          parsed,
          artifacts: {
            source: `/parsed-sheets-files/${refId}/${i + 1}-${safe}`,
            parsed: `/parsed-sheets-files/${refId}/${i + 1}-${safe}.parsed.json`,
          },
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[api/rates/parse-sheet] ${filename}:`, reason);
        results.push({ filename, ok: false, reason });
      }
      // Suppress unused-var warning when ext isn't read
      void ext;
    }

    // Persist parsed-sheet results so the user can search past quotes by
    // POL/POD without paying Claude again. Best-effort — a DB hiccup
    // shouldn't fail the parse response.
    try {
      const okFiles = results
        .filter((r) => r.ok && r.parsed && r.artifacts)
        .map((r) => ({
          filename: r.filename,
          parsed: r.parsed!,
          sourceUrl: r.artifacts!.source,
        }));
      const ratesForDb = ratesFromParsedResults(okFiles);
      await saveSheetUpload({
        refId,
        outputFolder: outDir,
        rows: ratesForDb,
        rawResults: { refId, outputFolder: outDir, results },
      });
    } catch (err) {
      console.error('[api/rates/parse-sheet] persist error:', err);
    }

    res.json({ refId, outputFolder: outDir, results });
  });

  // Search past parsed-sheet quotes by POL/POD substring.
  app.get('/api/sheets/history', async (req: Request, res: Response) => {
    const rawQ = req.query.q;
    const q = typeof rawQ === 'string' ? rawQ : '';
    try {
      const uploads = await searchSheetUploads(q, 50);
      res.json({ uploads });
    } catch (err) {
      console.error('[api/sheets/history] error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Load a saved upload by refId — returns the same shape the dashboard
  // gets from a fresh parse, so the same render path can replay it.
  app.get(
    '/api/sheets/history/:refId',
    async (req: Request, res: Response) => {
      const rawId = req.params.refId;
      const refId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!refId) {
        res.status(400).json({ error: 'refId is required' });
        return;
      }
      try {
        const detail = await getSheetUploadDetail(refId);
        if (!detail) {
          res.status(404).json({ error: 'Upload not found' });
          return;
        }
        res.json(detail);
      } catch (err) {
        console.error('[api/sheets/history/:refId] error:', err);
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  app.post('/api/sheets/reply', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      rows?: SheetReplyRow[];
      markupPct?: number | string;
      markupFlat?: number | string;
      /** New structured form — an array of toggled surcharge clauses. */
      surcharges?: Array<{
        kind: string;
        label: string;
        amount: number;
        currency?: string;
        basis?: string;
      }>;
      /** Legacy single-toggle fields (still accepted for backward compat). */
      addExportDeclaration?: boolean;
      exportDeclarationFee?: number | string;
      clientName?: string;
      emailTemplate?: string;
      /** When set, the saved upload row is updated so the email persists. */
      refId?: string;
    };
    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      res.status(400).json({ error: 'No rate rows provided.' });
      return;
    }
    try {
      const markupPct = Number(body.markupPct ?? 0);
      const markupFlat = Number(body.markupFlat ?? 0);
      // Normalize surcharges. Legacy callers (the old export-decl-only
      // toggle) get auto-translated into one item.
      const surcharges = Array.isArray(body.surcharges)
        ? body.surcharges
        : body.addExportDeclaration
          ? [
              {
                kind: 'export_declaration',
                label: 'Export declaration',
                amount: Number(body.exportDeclarationFee ?? 65),
                currency: 'USD',
                basis: 'per shipment',
              },
            ]
          : [];
      const text = await generateSheetReply({
        rows: body.rows,
        markupPct,
        markupFlat,
        surcharges,
        clientName: body.clientName,
        emailTemplate: body.emailTemplate,
      });
      // Persist the latest email + markup back to the saved row.
      if (body.refId) {
        await updateSheetUploadEmail(body.refId, {
          generatedEmail: text,
          markupPct,
          markupFlat,
          // Backward-compat persisted fields. Will become a JSON column later.
          addExportDeclaration: surcharges.some(
            (s) => s.kind === 'export_declaration'
          ),
          exportDeclarationFee:
            surcharges.find((s) => s.kind === 'export_declaration')?.amount ?? 0,
        }).catch((err) =>
          console.error('[api/sheets/reply] persist error:', err)
        );
      }
      res.json({ text });
    } catch (err) {
      console.error('[api/sheets/reply] error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---- Shipment board ----

  app.get('/api/shipments', async (req: Request, res: Response) => {
    const rawQ = req.query.q;
    const q = typeof rawQ === 'string' ? rawQ : '';
    try {
      const [rows, badges] = await Promise.all([
        listShipments(q),
        getDelayPredictBadgeMap(),
      ]);
      // Attach tracking badge per row (gray "Not tracked" if no match).
      const enriched = rows.map((r) => ({
        ...r,
        tracking: badges.get(r.refId) ?? {
          color: 'gray' as const,
          label: 'Not tracked',
          data: null,
        },
      }));
      res.json({ shipments: enriched });
    } catch (err) {
      console.error('[api/shipments] list error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Trigger a tracking refresh on DelayPredict for one shipment. */
  app.post(
    '/api/shipments/:refId/refresh-tracking',
    async (req: Request, res: Response) => {
      const rawId = req.params.refId;
      const refId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!refId) {
        res.status(400).json({ error: 'refId required' });
        return;
      }
      try {
        const tracking = await refreshDelayPredictTracking(refId);
        res.json({ refId, tracking });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  /** Create a row. If no body fields given, returns a blank row with a fresh ref id. */
  app.post('/api/shipments', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const row = await createShipment(body);
      res.json(row);
    } catch (err) {
      console.error('[api/shipments] create error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Inline-cell edit: PATCH a single field (or several). */
  app.patch('/api/shipments/:refId', async (req: Request, res: Response) => {
    const rawId = req.params.refId;
    const refId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!refId) {
      res.status(400).json({ error: 'refId required' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const updated = await updateShipment(refId, body);
      if (!updated) {
        res.status(404).json({ error: 'Shipment not found' });
        return;
      }
      res.json(updated);
    } catch (err) {
      console.error('[api/shipments/:refId] patch error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.delete('/api/shipments/:refId', async (req: Request, res: Response) => {
    const rawId = req.params.refId;
    const refId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!refId) {
      res.status(400).json({ error: 'refId required' });
      return;
    }
    try {
      const ok = await deleteShipment(refId);
      res.json({ ok });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * AI-extract from email screenshots / PDFs and create a new shipment row
   * pre-filled with the extracted fields. The user can then edit cells
   * inline. Original files are saved under shipments-files/<refId>/ for
   * audit and accessible via /shipments-files/<refId>/<filename>.
   */
  app.post('/api/shipments/parse', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      files?: Array<{
        filename?: string;
        contentBase64: string;
        mediaType?: BriefingMediaType;
      }>;
      /** If true, original files are NOT saved to disk — extract only.
       *  Use for confidential email content. Default false (keep). */
      ephemeral?: boolean;
      /** When the previous call returned questions[], the dashboard
       *  resends the same files plus the user's answers here. */
      userAnswers?: Array<{ question: string; answer: string }>;
    };
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0) {
      res.status(400).json({ error: 'No files provided.' });
      return;
    }
    const ephemeral = !!body.ephemeral;
    const userAnswers = Array.isArray(body.userAnswers) ? body.userAnswers : [];
    try {
      // Resolve media type per file. If the client supplied one, use it;
      // otherwise infer from filename. Then route text vs vision.
      const briefingFiles = files.map((f) => {
        const inferred =
          f.mediaType ?? (f.filename ? detectMediaType(f.filename) : null);
        if (!inferred) {
          throw new Error(`Could not detect media type for ${f.filename ?? 'file'}`);
        }
        const isText =
          inferred === 'message/rfc822' ||
          inferred === 'text/html' ||
          inferred === 'text/plain';
        if (isText) {
          // Decode base64 → utf-8 text. Send to Claude as text.
          const textContent = Buffer.from(
            f.contentBase64,
            'base64'
          ).toString('utf8');
          return {
            mediaType: inferred,
            filename: f.filename,
            textContent,
          };
        }
        return {
          mediaType: inferred,
          filename: f.filename,
          fileBase64: f.contentBase64,
        };
      });

      // Run extraction first so we know whether to create the row at all.
      const briefing = await parseShipmentBriefing(briefingFiles, userAnswers);

      // Two-step clarification: if Claude returned questions AND the
      // user hasn't already answered them, return WITHOUT creating a
      // row. Frontend pops a modal, collects answers, re-POSTs the
      // same files with userAnswers populated.
      const questions = briefing.questions ?? [];
      if (questions.length > 0 && userAnswers.length === 0) {
        res.json({ pendingClarification: true, questions });
        return;
      }

      // Create the row with extracted fields. Ref id is auto-allocated.
      const row = await createShipment({
        shipperName: briefing.shipper_name ?? null,
        receiverName: briefing.receiver_name ?? null,
        customerName: briefing.customer_name ?? null,
        loadingAddress: briefing.loading_address ?? null,
        pol: briefing.pol ?? null,
        polCode: briefing.pol_code ?? null,
        pod: briefing.pod ?? null,
        podCode: briefing.pod_code ?? null,
        containerType: briefing.container_type ?? null,
        cargoType: briefing.cargo_type ?? null,
        cargoName: briefing.cargo_name ?? null,
        soldRate: briefing.sold_rate ?? null,
        soldCurrency: briefing.sold_currency ?? 'USD',
        carrierPreference: briefing.carrier_preference ?? null,
        notes: briefing.notes ?? null,
      });

      // Save source files unless the user opted into ephemeral mode.
      let artifacts: Array<{
        filename: string;
        url: string;
        mediaType: string;
      }> = [];
      if (!ephemeral) {
        const { mkdir, writeFile } = await import('node:fs/promises');
        const outDir = resolve(`./shipments-files/${row.refId}`);
        await mkdir(outDir, { recursive: true });
        for (let i = 0; i < files.length; i++) {
          const f = files[i]!;
          const safe = (f.filename ?? `file-${i + 1}`).replace(
            /[^a-z0-9._-]/gi,
            '_'
          );
          const fp = resolve(outDir, `${i + 1}-${safe}`);
          await writeFile(fp, Buffer.from(f.contentBase64, 'base64'));
          artifacts.push({
            filename: f.filename ?? safe,
            url: `/shipments-files/${row.refId}/${i + 1}-${safe}`,
            mediaType: briefingFiles[i]!.mediaType,
          });
        }
        // Direct DB write — artifactsJson isn't on the EDITABLE_FIELDS allow-list.
        const db = createDbClient();
        const { shipments: shipmentsTbl } = await import('../db/schema.js');
        await db
          .update(shipmentsTbl)
          .set({ artifactsJson: artifacts, updatedAt: new Date() })
          .where(eq(shipmentsTbl.refId, row.refId));
      }
      const final = await getShipment(row.refId);

      res.json({ shipment: final ?? row, briefing, ephemeral });
    } catch (err) {
      console.error('[api/shipments/parse] error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---- Carrier credential vault ----
  // Local-only: passwords are AES-256-GCM encrypted at rest with a key in
  // .secrets/secrets.key (gitignored). The dashboard never returns plaintext
  // unless /reveal is called explicitly.

  app.get('/api/credentials', async (_req: Request, res: Response) => {
    try {
      res.json({ credentials: await listCredentials() });
    } catch (err) {
      console.error('[api/credentials] list error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.put('/api/credentials/:carrierCode', async (req: Request, res: Response) => {
    const rawId = req.params.carrierCode;
    const carrierCode = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!carrierCode) {
      res.status(400).json({ error: 'carrierCode is required' });
      return;
    }
    const body = (req.body ?? {}) as {
      username?: string;
      password?: string;
      notes?: string;
    };
    if (!body.username || !body.password) {
      res.status(400).json({ error: 'username and password are required' });
      return;
    }
    try {
      const summary = await upsertCredential({
        carrierCode,
        username: body.username,
        password: body.password,
        notes: body.notes ?? null,
      });
      res.json(summary);
    } catch (err) {
      console.error('[api/credentials] upsert error:', err);
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get(
    '/api/credentials/:carrierCode/reveal',
    async (req: Request, res: Response) => {
      const rawId = req.params.carrierCode;
      const carrierCode = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!carrierCode) {
        res.status(400).json({ error: 'carrierCode is required' });
        return;
      }
      try {
        const cred = await revealCredential(carrierCode);
        if (!cred) {
          res.status(404).json({ error: 'No credential stored for this carrier.' });
          return;
        }
        res.json(cred);
      } catch (err) {
        console.error('[api/credentials] reveal error:', err);
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  app.delete(
    '/api/credentials/:carrierCode',
    async (req: Request, res: Response) => {
      const rawId = req.params.carrierCode;
      const carrierCode = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!carrierCode) {
        res.status(400).json({ error: 'carrierCode is required' });
        return;
      }
      try {
        const ok = await deleteCredential(carrierCode);
        res.json({ ok });
      } catch (err) {
        console.error('[api/credentials] delete error:', err);
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );
}
