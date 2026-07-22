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
  replayRecording,
  getReplay,
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
  isMsgFile,
  type BriefingFile,
  type BriefingMediaType,
} from '../llm/parseShipmentBriefing.js';
import { toUsd, conversionAnnotation } from './fxRates.js';
import { convertMsgToEmailText } from '../llm/msgToText.js';
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

  // Replay a saved recording — spawns `tsx <file>` and returns a
  // replay id. Caller polls /api/record/replay/status/:id for live
  // stdout/stderr until status flips to finished/failed.
  app.post('/api/record/replay/:id', (req: Request, res: Response) => {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) {
      res.status(400).json({ error: 'recording id required' });
      return;
    }
    try {
      const meta = replayRecording(id);
      res.json(meta);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/record/replay/status/:id', (req: Request, res: Response) => {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) {
      res.status(400).json({ error: 'replay id required' });
      return;
    }
    const meta = getReplay(id);
    if (!meta) {
      res.status(404).json({ error: 'replay not found' });
      return;
    }
    res.json(meta);
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
  // ---- Scheduled web-agent tasks ----
  app.get('/api/scheduled-agents', async (_req: Request, res: Response) => {
    try {
      const { listScheduledAgents } = await import('./scheduledAgentsService.js');
      res.json({ agents: await listScheduledAgents() });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/scheduled-agents', async (req: Request, res: Response) => {
    try {
      const { upsertScheduledAgent } = await import('./scheduledAgentsService.js');
      const body = (req.body ?? {}) as {
        id?: number;
        name?: string;
        url?: string;
        goal?: string;
        intervalMinutes?: number;
        enabled?: boolean;
        maxIterations?: number;
      };
      if (!body.name || !body.url || !body.goal) {
        res.status(400).json({ error: 'name, url and goal are required' });
        return;
      }
      const row = await upsertScheduledAgent({
        id: body.id,
        name: body.name,
        url: body.url,
        goal: body.goal,
        intervalMinutes: body.intervalMinutes,
        enabled: body.enabled,
        maxIterations: body.maxIterations,
      });
      res.json(row);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.delete('/api/scheduled-agents/:id', async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      const { deleteScheduledAgent } = await import('./scheduledAgentsService.js');
      const ok = await deleteScheduledAgent(id);
      res.json({ ok });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/scheduled-agents/:id/run', async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      const { runScheduledAgent } = await import('./scheduledAgentsService.js');
      const result = await runScheduledAgent(id);
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

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
   * Drop-on-row update: AI-extract from a file dropped onto an existing
   * shipment row. Fills in any missing fields without overwriting fields
   * the user has already populated, and APPENDS cost line-items to the
   * existing breakdown (recalculating ourCost as the sum). Source files
   * are appended to the row's artifactsJson.
   */
  app.post(
    '/api/shipments/:refId/parse',
    async (req: Request, res: Response) => {
      const rawId = req.params.refId;
      const refId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!refId) {
        res.status(400).json({ error: 'refId required' });
        return;
      }
      const existing = await getShipment(refId);
      if (!existing) {
        res.status(404).json({ error: 'Shipment not found' });
        return;
      }
      const body = (req.body ?? {}) as {
        files?: Array<{
          filename?: string;
          contentBase64: string;
          mediaType?: BriefingMediaType;
        }>;
        ephemeral?: boolean;
        userAnswers?: Array<{ question: string; answer: string }>;
        /**
         * 'money' = user dropped on / clicked Sell/Cost/Profit cell.
         * AI focuses on cost_items / sold_rate / container_quantity
         * only; merge step skips routing/cargo/parties/notes etc.
         * 'all' (default) = full extraction.
         */
        mode?: 'money' | 'all';
        /**
         * When true, ignore body.files and re-run extraction against
         * the row's already-saved artifacts. Used by the "Re-check
         * from saved files" button — lets the AI take another pass
         * at money math without re-dropping anything.
         */
        useExistingFiles?: boolean;
        /**
         * Override map for FX conversion: { CAD: 0.73, EUR: 1.08, ... }
         * Each rate is "1 unit = N USD". Used to normalise non-USD
         * cost / sold line items to USD before persistence. Falls back
         * to the built-in defaults in fxRates.ts.
         */
        fxRates?: Record<string, number>;
      };
      const mode = body.mode === 'money' ? 'money' : 'all';
      const fxRates = body.fxRates || {};
      const files = Array.isArray(body.files) ? body.files : [];
      if (!body.useExistingFiles && files.length === 0) {
        res.status(400).json({ error: 'No files provided.' });
        return;
      }
      if (
        body.useExistingFiles &&
        (!existing.artifactsJson || existing.artifactsJson.length === 0)
      ) {
        res.status(400).json({
          error: 'No saved files for this shipment. Drop a file first.',
        });
        return;
      }
      try {
        // Two sources of files:
        //   - body.files (newly uploaded — drop / paste / browse)
        //   - useExistingFiles → load from disk (artifactsJson)
        // When both are set (e.g. user attached new files inside the
        // clarify modal during a recheck), they're concatenated so the
        // AI sees the full context.
        const briefingFiles: BriefingFile[] = [];
        if (body.useExistingFiles) {
          const { readFile } = await import('node:fs/promises');
          const arts = existing.artifactsJson ?? [];
          const fromDisk = await Promise.all(
            arts.map(async (a) => {
              // a.url is "/shipments-files/<refId>/<n>-<filename>" — map
              // back to the on-disk path under shipments-files/.
              const rel = a.url.replace(/^\/shipments-files\//, '');
              const disk = resolve(`./shipments-files/${rel}`);
              const buf = await readFile(disk);
              const filename = a.filename || rel.split('/').pop() || 'file';
              if (isMsgFile(filename)) {
                const ab = new ArrayBuffer(buf.byteLength);
                new Uint8Array(ab).set(buf);
                return {
                  mediaType: 'text/plain' as BriefingMediaType,
                  filename,
                  textContent: convertMsgToEmailText(ab),
                };
              }
              const inferred =
                (a.mediaType as BriefingMediaType) ||
                detectMediaType(filename);
              if (!inferred) {
                throw new Error(`Unknown media type for saved file ${filename}`);
              }
              if (
                inferred === 'message/rfc822' ||
                inferred === 'text/html' ||
                inferred === 'text/plain'
              ) {
                return {
                  mediaType: inferred,
                  filename,
                  textContent: buf.toString('utf8'),
                };
              }
              return {
                mediaType: inferred,
                filename,
                fileBase64: buf.toString('base64'),
              };
            })
          );
          briefingFiles.push(...fromDisk);
        }
        if (files.length > 0) {
          const fromUpload = files.map((f) => {
            if (isMsgFile(f.filename)) {
              const buf = Buffer.from(f.contentBase64, 'base64');
              const ab = new ArrayBuffer(buf.byteLength);
              new Uint8Array(ab).set(buf);
              return {
                mediaType: 'text/plain' as BriefingMediaType,
                filename: f.filename,
                textContent: convertMsgToEmailText(ab),
              };
            }
            const inferred =
              f.mediaType ?? (f.filename ? detectMediaType(f.filename) : null);
            if (!inferred) {
              throw new Error(
                `Could not detect media type for ${f.filename ?? 'file'}`
              );
            }
            if (
              inferred === 'message/rfc822' ||
              inferred === 'text/html' ||
              inferred === 'text/plain'
            ) {
              return {
                mediaType: inferred,
                filename: f.filename,
                textContent: Buffer.from(f.contentBase64, 'base64').toString('utf8'),
              };
            }
            return {
              mediaType: inferred,
              filename: f.filename,
              fileBase64: f.contentBase64,
            };
          });
          briefingFiles.push(...fromUpload);
        }

        // Money-mode directive: tell the AI to ignore everything except
        // money math, and to ALWAYS surface multiple-choice options
        // when 2+ totals are plausible (the bar is intentionally low).
        const directive =
          mode === 'money'
            ? 'MONEY-FOCUSED EXTRACTION: the user dropped these files specifically on the cost / sell / profit cell, OR clicked "Re-check from saved files". Extract ONLY cost_items, sold_rate, sold_currency, container_quantity. Leave shipper_name, receiver_name, customer_name, loading_address, fpol, pol, pod, container_type, cargo_type, cargo_name, carrier_preference, booking_ref, shipment_type, notes ALL set to null — they are not requested. ALWAYS surface multiple-choice questions whenever the document supports 2+ plausible interpretations of the total cost or the sold rate (per-container vs all-in, pre- vs post-discount, with vs without surcharges). The user wants to pick from candidates — do not silently choose for them.'
            : null;

        const briefing = await parseShipmentBriefing(
          briefingFiles,
          body.userAnswers ?? [],
          directive
        );

        // If the AI returned clarification questions and the user
        // hasn't yet answered them, surface them to the dashboard
        // (same pattern as the new-shipment /parse endpoint).
        const hasAnswers = (body.userAnswers ?? []).length > 0;
        if (
          !hasAnswers &&
          Array.isArray(briefing.questions) &&
          briefing.questions.length > 0
        ) {
          res.json({
            pendingClarification: true,
            questions: briefing.questions,
          });
          return;
        }

        // Merge: only fill in fields the row doesn't already have a
        // value for. Don't clobber user edits.
        // In money mode the field map is narrowed to just the money-
        // adjacent fields; everything else is left alone.
        const isEmpty = (v: unknown) => v == null || v === '';
        const fullFieldMap: Array<[keyof typeof existing, unknown]> = [
          ['shipperName', briefing.shipper_name ?? null],
          ['receiverName', briefing.receiver_name ?? null],
          ['customerName', briefing.customer_name ?? null],
          ['loadingAddress', briefing.loading_address ?? null],
          ['fpol', briefing.fpol ?? null],
          ['fpolCode', briefing.fpol_code ?? null],
          ['pol', briefing.pol ?? null],
          ['polCode', briefing.pol_code ?? null],
          ['pod', briefing.pod ?? null],
          ['podCode', briefing.pod_code ?? null],
          ['containerType', briefing.container_type ?? null],
          ['containerQuantity', briefing.container_quantity ?? null],
          ['cargoType', briefing.cargo_type ?? null],
          ['cargoName', briefing.cargo_name ?? null],
          ['carrierPreference', briefing.carrier_preference ?? null],
          ['bookingRef', briefing.booking_ref ?? null],
          ['shipmentType', briefing.shipment_type ?? null],
          ['soldRate', briefing.sold_rate ?? null],
          ['soldCurrency', briefing.sold_currency ?? null],
        ];
        const moneyFieldMap: Array<[keyof typeof existing, unknown]> = [
          ['containerQuantity', briefing.container_quantity ?? null],
          ['soldRate', briefing.sold_rate ?? null],
          ['soldCurrency', briefing.sold_currency ?? null],
        ];
        const fieldMap = mode === 'money' ? moneyFieldMap : fullFieldMap;

        const patch: Record<string, unknown> = {};
        for (const [key, val] of fieldMap) {
          if (val != null && val !== '' && isEmpty(existing[key])) {
            patch[key] = val;
          }
        }
        // In money mode, also OVERWRITE soldRate/containerQuantity even
        // if the row already has values — the user explicitly asked us
        // to re-check the figures, so the user-confirmed answer should
        // win over any stale value. Only re-apply if the AI returned
        // something (don't blank out a good value with null).
        if (mode === 'money') {
          for (const [key, val] of moneyFieldMap) {
            if (val != null && val !== '') patch[key] = val;
          }
        }

        // Append briefing notes to existing notes (don't overwrite).
        // Skipped in money mode — the user isn't asking about notes.
        if (
          mode !== 'money' &&
          briefing.notes &&
          briefing.notes.trim().length > 0
        ) {
          patch.notes = existing.notes
            ? `${existing.notes}\n\n${briefing.notes.trim()}`
            : briefing.notes.trim();
        }

        // Cost breakdown: append new line items (positive AND negative —
        // negative items represent discounts/credits like "1031 nautical
        // miles spent (-774 USD)"). Total ALWAYS equals sum(items).
        // If the row had a prior manual override (ourCost > sum of old
        // items), that delta is snapshotted as a "Previous adjustment"
        // item so the override is preserved AND visible in the panel.
        const newCostItems = (briefing.cost_items ?? []).filter(
          (c) => Number.isFinite(c.amount) && c.amount !== 0
        );
        const oldCostSum = (existing.costBreakdownJson ?? []).reduce(
          (s, c) => s + (c.amount || 0),
          0
        );
        const oldOurCost =
          typeof existing.ourCost === 'number' ? existing.ourCost : oldCostSum;
        const orphanCost = oldOurCost - oldCostSum;
        let costBreakdown = (existing.costBreakdownJson ?? []).slice();
        let costCurrency = existing.ourCostCurrency ?? null;
        if (
          costBreakdown.length > 0 &&
          Math.abs(orphanCost) > 0.005 &&
          newCostItems.length > 0
        ) {
          costBreakdown.push({
            name: 'Previous adjustment',
            amount: Math.round(orphanCost * 100) / 100,
            currency: costCurrency || 'USD',
            sourceFile: 'reconciled',
            addedAt: new Date().toISOString(),
          });
        }
        if (newCostItems.length > 0) {
          const sourceFile = files.map((f) => f.filename).filter(Boolean).join(', ') || null;
          const stamped = newCostItems.map((c) => {
            const conv = toUsd(c.amount, c.currency || 'USD', fxRates);
            const note = conversionAnnotation(conv);
            return {
              name: note ? `${c.name} ${note}` : c.name,
              amount: conv.amount,
              currency: 'USD',
              sourceFile,
              addedAt: new Date().toISOString(),
            };
          });
          costBreakdown = [...costBreakdown, ...stamped];
          costCurrency = 'USD';
        }
        const ourCost = costBreakdown.reduce(
          (s, c) => s + (c.amount || 0),
          0
        );
        if (newCostItems.length > 0) {
          // Direct DB write — these aren't on EDITABLE_FIELDS allow-list.
          const db = createDbClient();
          const { shipments: shipmentsTbl } = await import('../db/schema.js');
          await db
            .update(shipmentsTbl)
            .set({
              costBreakdownJson: costBreakdown,
              ourCost,
              ourCostCurrency: costCurrency || 'USD',
              updatedAt: new Date(),
            })
            .where(eq(shipmentsTbl.refId, refId));
        }

        // Same invariant for the sell side: total ALWAYS = sum(items).
        // Any prior manual override is snapshotted as a visible item.
        const newSoldItems = (briefing.sold_items ?? []).filter(
          (c) => Number.isFinite(c.amount) && c.amount !== 0
        );
        const oldSoldSum = (existing.soldBreakdownJson ?? []).reduce(
          (s, c) => s + (c.amount || 0),
          0
        );
        const oldSoldRate =
          typeof existing.soldRate === 'number' ? existing.soldRate : oldSoldSum;
        const orphanSold = oldSoldRate - oldSoldSum;
        let soldBreakdown = (existing.soldBreakdownJson ?? []).slice();
        let soldCurrency = existing.soldCurrency ?? null;
        if (
          soldBreakdown.length > 0 &&
          Math.abs(orphanSold) > 0.005 &&
          newSoldItems.length > 0
        ) {
          soldBreakdown.push({
            name: 'Previous adjustment',
            amount: Math.round(orphanSold * 100) / 100,
            currency: soldCurrency || 'USD',
            sourceFile: 'reconciled',
            addedAt: new Date().toISOString(),
          });
        }
        if (newSoldItems.length > 0) {
          const sourceFile =
            files.map((f) => f.filename).filter(Boolean).join(', ') || null;
          const stamped = newSoldItems.map((c) => {
            const conv = toUsd(c.amount, c.currency || 'USD', fxRates);
            const note = conversionAnnotation(conv);
            return {
              name: note ? `${c.name} ${note}` : c.name,
              amount: conv.amount,
              currency: 'USD',
              sourceFile,
              addedAt: new Date().toISOString(),
            };
          });
          soldBreakdown = [...soldBreakdown, ...stamped];
          soldCurrency = 'USD';
        }
        const newSoldRate = soldBreakdown.reduce(
          (s, c) => s + (c.amount || 0),
          0
        );
        if (newSoldItems.length > 0) {
          const db = createDbClient();
          const { shipments: shipmentsTbl } = await import('../db/schema.js');
          await db
            .update(shipmentsTbl)
            .set({
              soldBreakdownJson: soldBreakdown,
              soldRate: newSoldRate,
              soldCurrency: soldCurrency || 'USD',
              updatedAt: new Date(),
            })
            .where(eq(shipmentsTbl.refId, refId));
        }

        if (Object.keys(patch).length > 0) {
          await updateShipment(refId, patch);
        }

        // Save and append source files unless ephemeral, or unless
        // we're re-running against already-saved files (nothing new
        // to write to disk in that case).
        if (!body.ephemeral && !body.useExistingFiles) {
          const { mkdir, writeFile } = await import('node:fs/promises');
          const outDir = resolve(`./shipments-files/${refId}`);
          await mkdir(outDir, { recursive: true });
          const newArtifacts: Array<{
            filename: string;
            url: string;
            mediaType: string;
            addedAt: string;
          }> = [];
          const startIdx = (existing.artifactsJson?.length ?? 0) + 1;
          const stamp = new Date().toISOString();
          for (let i = 0; i < files.length; i++) {
            const f = files[i]!;
            const safe = (f.filename ?? `file-${startIdx + i}`).replace(
              /[^a-z0-9._-]/gi,
              '_'
            );
            const fp = resolve(outDir, `${startIdx + i}-${safe}`);
            await writeFile(fp, Buffer.from(f.contentBase64, 'base64'));
            newArtifacts.push({
              filename: f.filename ?? safe,
              url: `/shipments-files/${refId}/${startIdx + i}-${safe}`,
              mediaType: briefingFiles[i]!.mediaType,
              addedAt: stamp,
            });
          }
          const allArtifacts = [
            ...(existing.artifactsJson ?? []),
            ...newArtifacts,
          ];
          const db = createDbClient();
          const { shipments: shipmentsTbl } = await import('../db/schema.js');
          await db
            .update(shipmentsTbl)
            .set({ artifactsJson: allArtifacts, updatedAt: new Date() })
            .where(eq(shipmentsTbl.refId, refId));
        }

        const final = await getShipment(refId);
        res.json({
          shipment: final,
          briefing,
          fieldsFilled: Object.keys(patch).length,
          costItemsAdded: newCostItems.length,
        });
      } catch (err) {
        console.error('[api/shipments/:refId/parse] error:', err);
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  /**
   * Manual edit of cost or sold breakdowns. Used by the breakdown
   * panels to add a new line item, remove an existing one by index,
   * or update one in place. Whenever the breakdown changes, the
   * corresponding total (ourCost or soldRate) is recomputed as
   *   sum(breakdown) + manualDelta
   * where manualDelta preserves any direct cell-edit override the
   * user typed previously.
   */
  app.post(
    '/api/shipments/:refId/breakdown',
    async (req: Request, res: Response) => {
      const rawId = req.params.refId;
      const refId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!refId) {
        res.status(400).json({ error: 'refId required' });
        return;
      }
      const existing = await getShipment(refId);
      if (!existing) {
        res.status(404).json({ error: 'Shipment not found' });
        return;
      }
      const body = (req.body ?? {}) as {
        side?: 'cost' | 'sold';
        op?: 'add' | 'remove' | 'update' | 'set-total';
        index?: number;
        item?: { name?: string; amount?: number; currency?: string };
        amount?: number; // for set-total
        fxRates?: Record<string, number>;
      };
      const side = body.side === 'sold' ? 'sold' : 'cost';
      const op = body.op;
      const fxRates = body.fxRates || {};
      if (
        op !== 'add' &&
        op !== 'remove' &&
        op !== 'update' &&
        op !== 'set-total'
      ) {
        res.status(400).json({
          error: 'op must be add | remove | update | set-total',
        });
        return;
      }

      const breakdownKey =
        side === 'cost' ? 'costBreakdownJson' : 'soldBreakdownJson';
      const totalKey = side === 'cost' ? 'ourCost' : 'soldRate';
      const currencyKey =
        side === 'cost' ? 'ourCostCurrency' : 'soldCurrency';
      const oldBreakdown = (existing[breakdownKey] ?? []) as Array<{
        name: string;
        amount: number;
        currency: string;
        sourceFile?: string | null;
        addedAt?: string;
      }>;
      const oldSum = oldBreakdown.reduce((s, c) => s + (c.amount || 0), 0);
      const oldTotal =
        typeof existing[totalKey] === 'number'
          ? (existing[totalKey] as number)
          : oldSum;
      const defaultCurrency =
        (existing[currencyKey] as string | null) || 'USD';

      // Before any mutation, reconcile prior orphan totals: if the
      // stored total used to exceed sum(items) (legacy manualDelta from
      // older code), snapshot the difference as a visible line item so
      // historic overrides are preserved as the user starts editing.
      let next = oldBreakdown.slice();
      const orphanDelta = oldTotal - oldSum;
      if (
        next.length > 0 &&
        Math.abs(orphanDelta) > 0.005 &&
        op !== 'set-total'
      ) {
        next.push({
          name: 'Previous adjustment',
          amount: Math.round(orphanDelta * 100) / 100,
          currency: defaultCurrency,
          sourceFile: 'reconciled',
          addedAt: new Date().toISOString(),
        });
      }

      if (op === 'add') {
        const name = (body.item?.name ?? '').trim();
        const amount = Number(body.item?.amount);
        const currencyIn = (body.item?.currency || 'USD').toUpperCase();
        if (!name || !Number.isFinite(amount) || amount === 0) {
          res.status(400).json({
            error: 'add requires a non-empty name and a non-zero amount',
          });
          return;
        }
        // Convert non-USD amounts to USD using the same FX path as
        // AI-extracted items. Annotate the item name with the original
        // currency / rate so the user can audit the conversion later.
        const conv = toUsd(amount, currencyIn, fxRates);
        const note = conversionAnnotation(conv);
        next.push({
          name: note ? `${name} ${note}` : name,
          amount: conv.amount,
          currency: 'USD',
          sourceFile: 'manual',
          addedAt: new Date().toISOString(),
        });
      } else if (op === 'remove') {
        const idx = Number(body.index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= oldBreakdown.length) {
          res.status(400).json({ error: 'invalid index' });
          return;
        }
        // Index is into the ORIGINAL (pre-reconcile) array. Translate.
        const reconciled = next.length > oldBreakdown.length;
        next.splice(idx, 1);
        // If reconcile pushed an item, it's still at the end — keep it.
        // (Removing a real item shouldn't drop the reconcile entry.)
        void reconciled;
      } else if (op === 'update') {
        const idx = Number(body.index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= oldBreakdown.length) {
          res.status(400).json({ error: 'invalid index' });
          return;
        }
        const cur = next[idx]!;
        const name =
          typeof body.item?.name === 'string'
            ? body.item.name.trim()
            : cur.name;
        const amount =
          body.item?.amount != null && Number.isFinite(Number(body.item.amount))
            ? Number(body.item.amount)
            : cur.amount;
        const currency = body.item?.currency || cur.currency;
        next[idx] = { ...cur, name, amount, currency };
      } else if (op === 'set-total') {
        // User typed a new total directly into the cell. Replace the
        // entire breakdown with a single override item so the panel
        // always shows items that sum to the displayed total.
        const amount = Number(body.amount);
        if (!Number.isFinite(amount)) {
          res.status(400).json({ error: 'set-total requires a numeric amount' });
          return;
        }
        if (amount === 0) {
          next = [];
        } else {
          next = [
            {
              name: 'Manual total',
              amount,
              currency: defaultCurrency,
              sourceFile: 'manual',
              addedAt: new Date().toISOString(),
            },
          ];
        }
      }

      // Invariant: total ALWAYS equals sum(breakdown). No hidden delta.
      const newTotal = next.reduce((s, c) => s + (c.amount || 0), 0);

      const db = createDbClient();
      const { shipments: shipmentsTbl } = await import('../db/schema.js');
      await db
        .update(shipmentsTbl)
        .set({
          [breakdownKey]: next.length > 0 ? next : null,
          [totalKey]: next.length > 0 ? newTotal : null,
          [currencyKey]: defaultCurrency,
          updatedAt: new Date(),
        })
        .where(eq(shipmentsTbl.refId, refId));

      const final = await getShipment(refId);
      res.json({ shipment: final });
    }
  );

  /**
   * Read the text body of an attachment for in-app preview.
   * Used for .msg (decoded via msgreader), .eml (raw RFC 822),
   * .html (raw markup), and .txt (raw text). For PDFs / images,
   * the dashboard previews the file URL directly via iframe/img
   * and doesn't hit this endpoint.
   */
  app.get(
    '/api/shipments/:refId/artifacts/:index/text',
    async (req: Request, res: Response) => {
      const rawId = req.params.refId;
      const refId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!refId) {
        res.status(400).json({ error: 'refId required' });
        return;
      }
      const idx = Number(req.params.index);
      const existing = await getShipment(refId);
      if (!existing) {
        res.status(404).json({ error: 'Shipment not found' });
        return;
      }
      const arts = existing.artifactsJson ?? [];
      if (!Number.isInteger(idx) || idx < 0 || idx >= arts.length) {
        res.status(400).json({ error: 'invalid index' });
        return;
      }
      const a = arts[idx]!;
      const rel = (a.url ?? '').replace(/^\/shipments-files\//, '');
      if (!rel) {
        res.status(400).json({ error: 'artifact has no on-disk path' });
        return;
      }
      try {
        const { readFile } = await import('node:fs/promises');
        const buf = await readFile(resolve(`./shipments-files/${rel}`));
        const filename = a.filename || rel.split('/').pop() || 'file';
        if (isMsgFile(filename)) {
          const ab = new ArrayBuffer(buf.byteLength);
          new Uint8Array(ab).set(buf);
          res.json({
            filename,
            mediaType: 'text/plain',
            text: convertMsgToEmailText(ab),
          });
          return;
        }
        const lower = filename.toLowerCase();
        const isText =
          /\.(eml|html?|txt)$/.test(lower) ||
          a.mediaType === 'message/rfc822' ||
          a.mediaType === 'text/html' ||
          a.mediaType === 'text/plain';
        if (!isText) {
          res.status(400).json({
            error: 'this file type is binary — preview directly via the URL',
          });
          return;
        }
        res.json({
          filename,
          mediaType: a.mediaType || 'text/plain',
          text: buf.toString('utf8'),
        });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  /**
   * Delete a single attachment from a shipment by its index in
   * artifactsJson. Removes from the JSON array AND unlinks the
   * file from disk. Returns the updated row.
   */
  app.delete(
    '/api/shipments/:refId/artifacts/:index',
    async (req: Request, res: Response) => {
      const rawId = req.params.refId;
      const refId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!refId) {
        res.status(400).json({ error: 'refId required' });
        return;
      }
      const idx = Number(req.params.index);
      if (!Number.isInteger(idx) || idx < 0) {
        res.status(400).json({ error: 'invalid index' });
        return;
      }
      const existing = await getShipment(refId);
      if (!existing) {
        res.status(404).json({ error: 'Shipment not found' });
        return;
      }
      const arts = (existing.artifactsJson ?? []).slice();
      if (idx >= arts.length) {
        res.status(400).json({ error: 'index out of range' });
        return;
      }
      const [removed] = arts.splice(idx, 1);
      // Best-effort disk cleanup. Don't fail the request if the file
      // is already gone (it might have been manually deleted).
      try {
        const { unlink } = await import('node:fs/promises');
        const rel = (removed?.url ?? '').replace(/^\/shipments-files\//, '');
        if (rel) {
          await unlink(resolve(`./shipments-files/${rel}`)).catch(() => {});
        }
      } catch {
        /* ignore */
      }
      const db = createDbClient();
      const { shipments: shipmentsTbl } = await import('../db/schema.js');
      await db
        .update(shipmentsTbl)
        .set({
          artifactsJson: arts.length > 0 ? arts : null,
          updatedAt: new Date(),
        })
        .where(eq(shipmentsTbl.refId, refId));
      const final = await getShipment(refId);
      res.json({ shipment: final });
    }
  );

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
      /** FX overrides: { CAD: 0.73, EUR: 1.08, ... } — see fxRates.ts. */
      fxRates?: Record<string, number>;
    };
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0) {
      res.status(400).json({ error: 'No files provided.' });
      return;
    }
    const ephemeral = !!body.ephemeral;
    const userAnswers = Array.isArray(body.userAnswers) ? body.userAnswers : [];
    const fxRates = body.fxRates || {};
    try {
      // Resolve media type per file. If the client supplied one, use it;
      // otherwise infer from filename. Then route text vs vision.
      // .msg files are decoded server-side via msgreader and forwarded as
      // text/plain so Claude sees the same shape it sees for .eml.
      const briefingFiles = files.map((f) => {
        if (isMsgFile(f.filename)) {
          const buf = Buffer.from(f.contentBase64, 'base64');
          // Materialize a fresh ArrayBuffer (Buffer's underlying pool may
          // be shared / SharedArrayBuffer-like; msgreader wants a plain
          // ArrayBuffer of just our bytes).
          const ab = new ArrayBuffer(buf.byteLength);
          new Uint8Array(ab).set(buf);
          const textContent = convertMsgToEmailText(ab);
          return {
            mediaType: 'text/plain' as BriefingMediaType,
            filename: f.filename,
            textContent,
          };
        }
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

      // If the email mentions an existing freight-copilot ref (S0xxxx),
      // honour it: update the existing row in place if it exists, or
      // create a new row with that ref. Otherwise auto-allocate as
      // before. Anything not matching the S0xxxx pattern is ignored
      // here — carrier booking numbers / customer POs go in `notes`.
      const extractedRef = (briefing.our_reference_number ?? '').trim();
      const refMatchesPattern = /^S\d{3,}$/i.test(extractedRef);
      let row;
      // Initial cost breakdown from any line items the AI found.
      // Allow negative amounts (discounts / loyalty credits) — only
      // exclude zeros and NaN.
      const initialCostItems = (briefing.cost_items ?? []).filter(
        (c) => Number.isFinite(c.amount) && c.amount !== 0
      );
      const stampedCosts = initialCostItems.map((c) => {
        const conv = toUsd(c.amount, c.currency || 'USD', fxRates);
        const note = conversionAnnotation(conv);
        return {
          name: note ? `${c.name} ${note}` : c.name,
          amount: conv.amount,
          currency: 'USD',
          sourceFile: files.map((f) => f.filename).filter(Boolean).join(', ') || null,
          addedAt: new Date().toISOString(),
        };
      });
      const initialOurCost = stampedCosts.reduce(
        (s, c) => s + (c.amount || 0),
        0
      );
      // Same pattern for the sell side.
      const initialSoldItems = (briefing.sold_items ?? []).filter(
        (c) => Number.isFinite(c.amount) && c.amount !== 0
      );
      const stampedSold = initialSoldItems.map((c) => {
        const conv = toUsd(c.amount, c.currency || 'USD', fxRates);
        const note = conversionAnnotation(conv);
        return {
          name: note ? `${c.name} ${note}` : c.name,
          amount: conv.amount,
          currency: 'USD',
          sourceFile:
            files.map((f) => f.filename).filter(Boolean).join(', ') || null,
          addedAt: new Date().toISOString(),
        };
      });
      const initialSoldFromItems = stampedSold.reduce(
        (s, c) => s + (c.amount || 0),
        0
      );
      // If both AI sold_rate and sold_items are present, prefer the
      // sum of items (it's the breakdown the user can edit).
      const initialSoldRate =
        stampedSold.length > 0
          ? initialSoldFromItems
          : (briefing.sold_rate ?? null);
      const fieldsFromBriefing = {
        shipperName: briefing.shipper_name ?? null,
        receiverName: briefing.receiver_name ?? null,
        customerName: briefing.customer_name ?? null,
        loadingAddress: briefing.loading_address ?? null,
        fpol: briefing.fpol ?? null,
        fpolCode: briefing.fpol_code ?? null,
        pol: briefing.pol ?? null,
        polCode: briefing.pol_code ?? null,
        pod: briefing.pod ?? null,
        podCode: briefing.pod_code ?? null,
        containerType: briefing.container_type ?? null,
        containerQuantity: briefing.container_quantity ?? null,
        cargoType: briefing.cargo_type ?? null,
        cargoName: briefing.cargo_name ?? null,
        soldRate: initialSoldRate,
        soldCurrency: 'USD',
        soldBreakdownJson: stampedSold.length > 0 ? stampedSold : null,
        ourCost: stampedCosts.length > 0 ? initialOurCost : null,
        ourCostCurrency: 'USD',
        costBreakdownJson: stampedCosts.length > 0 ? stampedCosts : null,
        carrierPreference: briefing.carrier_preference ?? null,
        bookingRef: briefing.booking_ref ?? null,
        shipmentType: briefing.shipment_type ?? null,
        notes: briefing.notes ?? null,
      };
      if (refMatchesPattern) {
        const normalized = extractedRef.toUpperCase();
        const existing = await getShipment(normalized);
        if (existing) {
          // Merge: only overwrite fields the AI extracted with a value;
          // keep whatever the user has already typed in for the rest.
          const patch: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(fieldsFromBriefing)) {
            if (v != null && v !== '') patch[k] = v;
          }
          await updateShipment(normalized, patch);
          row = (await getShipment(normalized))!;
        } else {
          row = await createShipment({ refId: normalized, ...fieldsFromBriefing });
        }
      } else {
        row = await createShipment(fieldsFromBriefing);
      }

      // Save source files unless the user opted into ephemeral mode.
      let artifacts: Array<{
        filename: string;
        url: string;
        mediaType: string;
        addedAt: string;
      }> = [];
      if (!ephemeral) {
        const { mkdir, writeFile } = await import('node:fs/promises');
        const outDir = resolve(`./shipments-files/${row.refId}`);
        await mkdir(outDir, { recursive: true });
        const stamp = new Date().toISOString();
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
            addedAt: stamp,
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

  // ---- App-level settings (DB-backed, beats .env) ----
  app.get('/api/settings', async (_req: Request, res: Response) => {
    try {
      const { listSettings } = await import('./appSettingsService.js');
      const stored = await listSettings();
      // Surface the resolved (DB OR env) view so the dashboard can show
      // "current value" alongside "saved override".
      const envView = {
        AI_PROVIDER: process.env.AI_PROVIDER ?? null,
        AI_MODEL: process.env.AI_MODEL ?? null,
        AI_MODEL_FALLBACK: process.env.AI_MODEL_FALLBACK ?? null,
        DELAYPREDICT_URL: process.env.DELAYPREDICT_URL ?? null,
        INTELLCLUSTER_URL: process.env.INTELLCLUSTER_URL ?? null,
      };
      res.json({ settings: stored, env: envView });
    } catch (err) {
      console.error('[api/settings] list error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.put('/api/settings/:key', async (req: Request, res: Response) => {
    const rawKey = req.params.key;
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!key) {
      res.status(400).json({ error: 'key is required' });
      return;
    }
    const body = (req.body ?? {}) as { value?: string };
    if (typeof body.value !== 'string' || body.value.trim() === '') {
      res.status(400).json({ error: 'value is required' });
      return;
    }
    // Allow-list — only specific keys are settable from the UI.
    const ALLOWED = new Set([
      'AI_MODE',
      'AI_PROVIDER',
      'AI_MODEL',
      'AI_MODEL_FALLBACK',
      'DELAYPREDICT_URL',
      'INTELLCLUSTER_URL',
    ]);
    if (!ALLOWED.has(key)) {
      res.status(400).json({ error: `setting "${key}" is not user-editable` });
      return;
    }
    try {
      const { setSetting } = await import('./appSettingsService.js');
      await setSetting(key, body.value.trim());
      res.json({ ok: true, key, value: body.value.trim() });
    } catch (err) {
      console.error('[api/settings] put error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.delete('/api/settings/:key', async (req: Request, res: Response) => {
    const rawKey = req.params.key;
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!key) {
      res.status(400).json({ error: 'key is required' });
      return;
    }
    try {
      const { deleteSetting } = await import('./appSettingsService.js');
      const ok = await deleteSetting(key);
      res.json({ ok });
    } catch (err) {
      console.error('[api/settings] delete error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---- AI provider API keys (encrypted vault) ----
  // GET returns masked summaries (last 4 chars). Plaintext keys never
  // leave the server.
  app.get('/api/ai-keys', async (_req: Request, res: Response) => {
    try {
      const { getProviderStatuses } = await import('./apiKeysService.js');
      const { describeMasterKey } = await import('./secretsCrypto.js');
      // Never returns key values — statuses carry only a last-4 mask + state.
      res.json({ providers: await getProviderStatuses(), masterKey: describeMasterKey() });
    } catch (err) {
      console.error('[api/ai-keys] list error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Could not read provider key status.' });
    }
  });

  app.put('/api/ai-keys/:provider', async (req: Request, res: Response) => {
    const rawId = req.params.provider;
    const provider = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!provider) {
      res.status(400).json({ error: 'provider is required' });
      return;
    }
    const body = (req.body ?? {}) as { key?: string; label?: string };
    if (!body.key || typeof body.key !== 'string' || body.key.trim() === '') {
      res.status(400).json({ error: 'key is required' });
      return;
    }
    try {
      const { upsertApiKey, normalizeProvider, getProviderStatuses } = await import(
        './apiKeysService.js'
      );
      const canonical = normalizeProvider(provider);
      const existedBefore = (await getProviderStatuses()).find(
        (s) => s.provider === canonical,
      )?.storedRow;
      const status = await upsertApiKey({ provider, key: body.key, label: body.label });
      const { recordAuditEvent } = await import('./auditService.js');
      await recordAuditEvent({
        eventType: existedBefore ? 'api_key.replaced' : 'api_key.added',
        provider: status.provider,
        source: 'dashboard',
        success: true,
        sanitizedMessage: `${status.provider} key ${existedBefore ? 'replaced' : 'added'} in the encrypted vault`,
      });
      res.json(status);
    } catch (err) {
      console.error('[api/ai-keys] upsert error:', err instanceof Error ? err.message : err);
      res.status(400).json({ error: err instanceof Error ? err.message : 'Could not save key.' });
    }
  });

  app.delete('/api/ai-keys/:provider', async (req: Request, res: Response) => {
    const rawId = req.params.provider;
    const provider = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!provider) {
      res.status(400).json({ error: 'provider is required' });
      return;
    }
    try {
      const { deleteApiKey, normalizeProvider } = await import('./apiKeysService.js');
      const ok = await deleteApiKey(provider);
      const { recordAuditEvent } = await import('./auditService.js');
      await recordAuditEvent({
        eventType: 'api_key.removed',
        provider: normalizeProvider(provider),
        source: 'dashboard',
        success: ok,
        sanitizedMessage: ok
          ? `${normalizeProvider(provider)} key removed from the encrypted vault`
          : `no stored ${normalizeProvider(provider)} key to remove`,
      });
      res.json({ ok });
    } catch (err) {
      console.error('[api/ai-keys] delete error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Could not remove key.' });
    }
  });

  // Objective 2 — one-click, idempotent import of env-provided keys into the
  // encrypted vault. Never deletes env values, never overwrites a decryptable
  // stored key. Returns provider names + actions only (never key values).
  app.post('/api/ai-keys/migrate', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { overwriteLocked?: boolean };
      const { migrateEnvKeysToVault } = await import('./apiKeysService.js');
      const results = await migrateEnvKeysToVault({ overwriteLocked: body.overwriteLocked === true });
      const imported = results.filter((r) => r.action === 'imported').map((r) => r.provider);
      const { recordAuditEvent } = await import('./auditService.js');
      await recordAuditEvent({
        eventType: 'env_migration.completed',
        provider: null,
        source: 'dashboard',
        success: true,
        sanitizedMessage:
          imported.length > 0
            ? `imported ${imported.length} provider key(s) from environment: ${imported.join(', ')}`
            : 'no new provider keys imported from environment',
      });
      res.json({ results });
    } catch (err) {
      console.error('[api/ai-keys] migrate error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Could not import environment keys.' });
    }
  });

  // Objective 6 — safe per-provider connection test (cheap metadata call only).
  app.post('/api/ai-keys/:provider/test', async (req: Request, res: Response) => {
    const rawId = req.params.provider;
    const provider = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!provider) {
      res.status(400).json({ error: 'provider is required' });
      return;
    }
    try {
      const { testProviderConnection } = await import('./providerConnectionTest.js');
      const result = await testProviderConnection(provider);
      const { recordAuditEvent } = await import('./auditService.js');
      await recordAuditEvent({
        eventType: 'connection.tested',
        provider: result.provider,
        source: 'dashboard',
        success: result.success,
        sanitizedMessage: result.success
          ? `connection ok via ${result.endpoint} (${result.latencyMs}ms)`
          : `connection failed: ${result.error ?? 'unknown error'}`,
      });
      res.json(result);
    } catch (err) {
      console.error('[api/ai-keys] test error:', err instanceof Error ? err.message : err);
      res.status(400).json({ error: err instanceof Error ? err.message : 'Could not test provider.' });
    }
  });

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

  // =================================================================
  // Drayage Rate Library — the user's archive of provider rate sheets.
  // Append-only: every parse adds new rows, never overwrites old ones,
  // so price history is preserved.
  // =================================================================

  app.post(
    '/api/drayage-rate-library/parse',
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        files?: Array<{
          filename?: string;
          contentBase64: string;
          mediaType?: BriefingMediaType;
        }>;
        ephemeral?: boolean;
        fxRates?: Record<string, number>;
        /** When true, run AI + FX conversion only and return the
         *  extracted rates for the user to review. No files are written
         *  to disk and no rows are inserted. The user then edits and
         *  POSTs the (possibly edited) rates to /save. */
        dryRun?: boolean;
      };
      const files = Array.isArray(body.files) ? body.files : [];
      if (files.length === 0) {
        res.status(400).json({ error: 'No files provided.' });
        return;
      }
      const fxRates = body.fxRates || {};
      const dryRun = !!body.dryRun;
      try {
        // Same media-type routing as the shipment briefing path.
        const briefingFiles: BriefingFile[] = files.map((f) => {
          if (isMsgFile(f.filename)) {
            const buf = Buffer.from(f.contentBase64, 'base64');
            const ab = new ArrayBuffer(buf.byteLength);
            new Uint8Array(ab).set(buf);
            return {
              mediaType: 'text/plain' as BriefingMediaType,
              filename: f.filename,
              textContent: convertMsgToEmailText(ab),
            };
          }
          const inferred =
            f.mediaType ?? (f.filename ? detectMediaType(f.filename) : null);
          if (!inferred) {
            throw new Error(
              `Could not detect media type for ${f.filename ?? 'file'}`
            );
          }
          if (
            inferred === 'message/rfc822' ||
            inferred === 'text/html' ||
            inferred === 'text/plain'
          ) {
            return {
              mediaType: inferred,
              filename: f.filename,
              textContent: Buffer.from(f.contentBase64, 'base64').toString('utf8'),
            };
          }
          return {
            mediaType: inferred,
            filename: f.filename,
            fileBase64: f.contentBase64,
          };
        });

        const { parseDrayageRates } = await import(
          '../llm/parseDrayageRates.js'
        );
        const result = await parseDrayageRates(briefingFiles);
        const rates = result.rates ?? [];
        if (rates.length === 0) {
          res.json({ inserted: 0, rates: [], message: 'No rates found in document.' });
          return;
        }

        // Dry-run path — return the AI-extracted rates (FX-converted)
        // without writing files or DB rows. The dashboard shows them
        // for review/editing, then POSTs to /save when the user confirms.
        if (dryRun) {
          const previewRates = rates.map((r) => {
            const baseConv = toUsd(r.base_rate ?? 0, r.currency || 'USD', fxRates);
            const totalConv = toUsd(
              r.total_rate ?? r.base_rate ?? 0,
              r.currency || 'USD',
              fxRates
            );
            const surchargesUsd = (r.surcharges ?? []).map((s) => {
              const conv = toUsd(s.amount, s.currency || r.currency || 'USD', fxRates);
              return { name: s.name, amount: conv.amount, currency: 'USD' };
            });
            return {
              rateDate: r.rate_date ?? null,
              providerName: r.provider_name ?? null,
              pickupAddress: r.pickup_address ?? null,
              pickupCity: r.pickup_city ?? null,
              pickupState: r.pickup_state ?? null,
              pickupZip: r.pickup_zip ?? null,
              pickupCountry: r.pickup_country ?? 'US',
              pickupLabel:
                r.pickup_label ??
                [r.pickup_city, r.pickup_state].filter(Boolean).join(', ') ??
                null,
              deliveryAddress: r.delivery_address ?? null,
              deliveryCity: r.delivery_city ?? null,
              deliveryState: r.delivery_state ?? null,
              deliveryZip: r.delivery_zip ?? null,
              deliveryCountry: r.delivery_country ?? 'US',
              deliveryLabel:
                r.delivery_label ??
                [r.delivery_city, r.delivery_state].filter(Boolean).join(', ') ??
                null,
              totalMiles: r.total_miles ?? null,
              containerType: r.container_type ?? null,
              maxWeightKg: r.max_weight_kg ?? null,
              baseRate: baseConv.amount,
              totalRate: totalConv.amount,
              surchargesJson: surchargesUsd.length > 0 ? surchargesUsd : null,
              sourceCurrency: (r.currency || 'USD').toUpperCase(),
              notes: r.notes ?? null,
            };
          });
          res.json({ rates: previewRates });
          return;
        }

        // Persist source files to disk (one folder per upload batch).
        let sourceUrlBase: string | null = null;
        let sourceFilename: string | null = null;
        if (!body.ephemeral) {
          const { mkdir, writeFile } = await import('node:fs/promises');
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const batchId = `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
          const outDir = resolve(`./drayage-rates-files/${batchId}`);
          await mkdir(outDir, { recursive: true });
          const stored: string[] = [];
          for (let i = 0; i < files.length; i++) {
            const f = files[i]!;
            const safe = (f.filename ?? `file-${i + 1}`).replace(
              /[^a-z0-9._-]/gi,
              '_'
            );
            const fp = resolve(outDir, `${i + 1}-${safe}`);
            await writeFile(fp, Buffer.from(f.contentBase64, 'base64'));
            stored.push(`/drayage-rates-files/${batchId}/${i + 1}-${safe}`);
          }
          sourceUrlBase = stored[0] ?? null;
          sourceFilename = files.map((f) => f.filename).filter(Boolean).join(', ') || null;
        }

        // Convert rates to USD + insert into DB.
        const db = createDbClient();
        const { drayageRateLibrary } = await import('../db/schema.js');
        const inserts = rates.map((r) => {
          const baseConv = toUsd(
            r.base_rate ?? 0,
            r.currency || 'USD',
            fxRates
          );
          const totalConv = toUsd(
            r.total_rate ?? r.base_rate ?? 0,
            r.currency || 'USD',
            fxRates
          );
          const surchargesUsd = (r.surcharges ?? []).map((s) => {
            const conv = toUsd(s.amount, s.currency || r.currency || 'USD', fxRates);
            return {
              name: s.name,
              amount: conv.amount,
              currency: 'USD',
            };
          });
          const searchKey = [
            r.pickup_label,
            r.pickup_city,
            r.pickup_state,
            r.pickup_zip,
            r.delivery_label,
            r.delivery_city,
            r.delivery_state,
            r.delivery_zip,
            r.container_type,
            r.provider_name,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return {
            rateDate: r.rate_date ?? null,
            providerName: r.provider_name ?? null,
            pickupAddress: r.pickup_address ?? null,
            pickupCity: r.pickup_city ?? null,
            pickupState: r.pickup_state ?? null,
            pickupZip: r.pickup_zip ?? null,
            pickupCountry: r.pickup_country ?? 'US',
            pickupLabel:
              r.pickup_label ??
              [r.pickup_city, r.pickup_state].filter(Boolean).join(', ') ??
              null,
            deliveryAddress: r.delivery_address ?? null,
            deliveryCity: r.delivery_city ?? null,
            deliveryState: r.delivery_state ?? null,
            deliveryZip: r.delivery_zip ?? null,
            deliveryCountry: r.delivery_country ?? 'US',
            deliveryLabel:
              r.delivery_label ??
              [r.delivery_city, r.delivery_state].filter(Boolean).join(', ') ??
              null,
            totalMiles: r.total_miles ?? null,
            containerType: r.container_type ?? null,
            maxWeightKg: r.max_weight_kg ?? null,
            baseRate: baseConv.amount,
            totalRate: totalConv.amount,
            surchargesJson: surchargesUsd.length > 0 ? surchargesUsd : null,
            sourceCurrency: (r.currency || 'USD').toUpperCase(),
            notes: r.notes ?? null,
            sourceUrl: sourceUrlBase,
            sourceFilename,
            searchKey,
          };
        });
        await db.insert(drayageRateLibrary).values(inserts);
        res.json({ inserted: inserts.length });
      } catch (err) {
        console.error('[api/drayage-rate-library/parse] error:', err);
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  /**
   * Save user-reviewed rates (after a dry-run /parse) into the
   * library. Accepts an array of rate objects already in USD form,
   * plus the original files to persist alongside them.
   */
  app.post(
    '/api/drayage-rate-library/save',
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        rates?: Array<Record<string, unknown>>;
        files?: Array<{
          filename?: string;
          contentBase64: string;
          mediaType?: string;
        }>;
        ephemeral?: boolean;
      };
      const rates = Array.isArray(body.rates) ? body.rates : [];
      const files = Array.isArray(body.files) ? body.files : [];
      if (rates.length === 0) {
        res.status(400).json({ error: 'No rates provided.' });
        return;
      }
      try {
        // Persist files first if any.
        let sourceUrlBase: string | null = null;
        let sourceFilename: string | null = null;
        if (!body.ephemeral && files.length > 0) {
          const { mkdir, writeFile } = await import('node:fs/promises');
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const batchId = `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
          const outDir = resolve(`./drayage-rates-files/${batchId}`);
          await mkdir(outDir, { recursive: true });
          const stored: string[] = [];
          for (let i = 0; i < files.length; i++) {
            const f = files[i]!;
            const safe = (f.filename ?? `file-${i + 1}`).replace(
              /[^a-z0-9._-]/gi,
              '_'
            );
            const fp = resolve(outDir, `${i + 1}-${safe}`);
            await writeFile(fp, Buffer.from(f.contentBase64, 'base64'));
            stored.push(`/drayage-rates-files/${batchId}/${i + 1}-${safe}`);
          }
          sourceUrlBase = stored[0] ?? null;
          sourceFilename =
            files.map((f) => f.filename).filter(Boolean).join(', ') || null;
        }

        const db = createDbClient();
        const { drayageRateLibrary } = await import('../db/schema.js');
        const inserts = rates.map((r) => {
          const num = (v: unknown) =>
            typeof v === 'number' && Number.isFinite(v)
              ? v
              : v != null && v !== '' && Number.isFinite(Number(v))
                ? Number(v)
                : null;
          const str = (v: unknown) =>
            typeof v === 'string' && v.trim() ? v.trim() : null;
          const searchKey = [
            str(r.pickupLabel),
            str(r.pickupCity),
            str(r.pickupState),
            str(r.pickupZip),
            str(r.deliveryLabel),
            str(r.deliveryCity),
            str(r.deliveryState),
            str(r.deliveryZip),
            str(r.containerType),
            str(r.providerName),
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return {
            rateDate: str(r.rateDate),
            providerName: str(r.providerName),
            pickupAddress: str(r.pickupAddress),
            pickupCity: str(r.pickupCity),
            pickupState: str(r.pickupState),
            pickupZip: str(r.pickupZip),
            pickupCountry: str(r.pickupCountry) ?? 'US',
            pickupLabel: str(r.pickupLabel),
            deliveryAddress: str(r.deliveryAddress),
            deliveryCity: str(r.deliveryCity),
            deliveryState: str(r.deliveryState),
            deliveryZip: str(r.deliveryZip),
            deliveryCountry: str(r.deliveryCountry) ?? 'US',
            deliveryLabel: str(r.deliveryLabel),
            totalMiles: num(r.totalMiles),
            containerType: str(r.containerType),
            maxWeightKg: num(r.maxWeightKg),
            baseRate: num(r.baseRate),
            totalRate: num(r.totalRate),
            surchargesJson: Array.isArray(r.surchargesJson)
              ? (r.surchargesJson as Array<{
                  name: string;
                  amount: number;
                  currency: string;
                }>)
              : null,
            sourceCurrency: str(r.sourceCurrency) ?? 'USD',
            notes: str(r.notes),
            sourceUrl: sourceUrlBase,
            sourceFilename,
            searchKey,
          };
        });
        await db.insert(drayageRateLibrary).values(inserts);
        res.json({ inserted: inserts.length });
      } catch (err) {
        console.error('[api/drayage-rate-library/save] error:', err);
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  app.get(
    '/api/drayage-rate-library',
    async (req: Request, res: Response) => {
      try {
        const q = String(req.query.q ?? '').trim().toLowerCase();
        const from = String(req.query.from ?? '').trim().toLowerCase();
        const to = String(req.query.to ?? '').trim().toLowerCase();
        const cntr = String(req.query.cntr ?? '').trim().toUpperCase();
        const db = createDbClient();
        const { drayageRateLibrary } = await import('../db/schema.js');
        let rows = await db
          .select()
          .from(drayageRateLibrary)
          .orderBy(desc(drayageRateLibrary.createdAt));
        if (q) rows = rows.filter((r) => (r.searchKey ?? '').includes(q));
        if (from) {
          rows = rows.filter((r) =>
            [r.pickupCity, r.pickupState, r.pickupZip, r.pickupLabel]
              .filter(Boolean)
              .some((s) => String(s).toLowerCase().includes(from))
          );
        }
        if (to) {
          rows = rows.filter((r) =>
            [r.deliveryCity, r.deliveryState, r.deliveryZip, r.deliveryLabel]
              .filter(Boolean)
              .some((s) => String(s).toLowerCase().includes(to))
          );
        }
        if (cntr) {
          rows = rows.filter(
            (r) => (r.containerType ?? '').toUpperCase() === cntr
          );
        }
        res.json({ rates: rows });
      } catch (err) {
        console.error('[api/drayage-rate-library] list error:', err);
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  app.delete(
    '/api/drayage-rate-library/:id',
    async (req: Request, res: Response) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
          res.status(400).json({ error: 'invalid id' });
          return;
        }
        const db = createDbClient();
        const { drayageRateLibrary } = await import('../db/schema.js');
        await db
          .delete(drayageRateLibrary)
          .where(eq(drayageRateLibrary.id, id));
        res.json({ ok: true });
      } catch (err) {
        console.error('[api/drayage-rate-library] delete error:', err);
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );
}
