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
import { quoteBundles } from '../db/schema.js';
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
}

function csvEscape(v: string): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function registerApiRoutes(app: Express): void {
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
