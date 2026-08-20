import { timingSafeEqual } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { parseRawEmail, parsedEmailToPromptText } from '../llm/emailToText.js';
import { parseRateSheet, type RateSheetResult } from '../llm/parseRateSheet.js';
import {
  ratesFromParsedResults,
  saveSheetUpload,
  findSheetUploadByMessageId,
  type SheetUploadRowInput,
  type SheetUploadInput,
} from '../db/sheetHistory.js';

/**
 * BCC-email → SELL-rate ingest.
 *
 * Alex BCCs a fixed address on the rate quotes he emails customers. A
 * mail-forwarding worker relays the raw MIME to POST /api/rates/ingest-email.
 * We reuse the EXACT ocean-rate extraction the drag/drop sheet-upload flow uses
 * (parseRateSheet), then persist each extracted rate into the same sheet_rates
 * library — but flagged rate_type='sell', source_type='email_bcc', with a
 * visible disclaimer note, so it reads as a reference (our own quote, margin
 * already included), never as a carrier buy rate.
 *
 * The pipeline (runEmailRateIngest) is dependency-injected so it unit-tests
 * without a database or a live AI provider.
 */

/** The disclaimer stamped on every rate ingested from a BCC'd quote. */
export const SELL_RATE_NOTE =
  'Quoted by us — SELL rate (your margin already included). Reference only, not a carrier buy rate.';

export type IngestStatus = 'ingested' | 'duplicate' | 'not_a_quote' | 'error';

export interface IngestResult {
  status: IngestStatus;
  rateCount?: number;
  uploadId?: number;
  refId?: string;
  message?: string;
}

/**
 * Is this parsed document actually a rate quote worth saving? It must be
 * classified as a rate sheet AND carry at least one concrete rate row. A
 * customer inquiry ('quote_request'), an 'other' document, or a rate sheet with
 * no extractable rates all resolve to not_a_quote → nothing is persisted.
 */
export function isRateQuote(parsed: RateSheetResult): boolean {
  const rateRows = parsed.lanes.reduce(
    (sum, lane) => sum + (lane.rates_per_container?.length ?? 0),
    0
  );
  return parsed.document_type === 'rate_sheet' && rateRows > 0;
}

/**
 * Map a parsed ocean rate sheet to sheet_rates rows flagged as SELL / email_bcc
 * with the disclaimer note. Reuses ratesFromParsedResults (the same flattening
 * the file path uses) so the extracted fields are identical — only the
 * provenance flags differ.
 */
export function sellRowsFromParsed(
  parsed: RateSheetResult,
  sourceFilename: string
): SheetUploadRowInput[] {
  const base = ratesFromParsedResults([
    { filename: sourceFilename, parsed, sourceUrl: null },
  ]);
  return base.map((row) => ({
    ...row,
    rateType: 'sell' as const,
    sourceType: 'email_bcc' as const,
    sourceNote: SELL_RATE_NOTE,
  }));
}

function emailRefId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `EM-${date}-${rand}`;
}

export interface IngestDeps {
  /** Extract an ocean rate sheet from the email's text block. */
  parse: (promptText: string, filename: string) => Promise<RateSheetResult>;
  /** Dedupe lookup by RFC-822 Message-ID. */
  findByMessageId: (messageId: string) => Promise<{ id: number; refId: string } | null>;
  /** Persist the synthetic upload + its sell rows. Returns the new upload id. */
  save: (input: SheetUploadInput) => Promise<number>;
  /** Ref-id generator (overridable in tests for determinism). */
  genRefId?: () => string;
}

/**
 * Core ingest pipeline. Pure orchestration over injected I/O so it is fully
 * unit-testable. Never throws for an expected outcome — parse/dedupe/not-a-quote
 * are returned as statuses; only a genuinely unexpected dependency failure
 * propagates (the route maps it to a clean response).
 */
export async function runEmailRateIngest(
  input: { raw: string; filename?: string | null },
  deps: IngestDeps
): Promise<IngestResult> {
  const email = parseRawEmail(input.raw ?? '');

  // 1) Dedupe on Message-ID: a re-delivered copy of the same quote is a no-op.
  if (email.messageId) {
    const existing = await deps.findByMessageId(email.messageId);
    if (existing) {
      return { status: 'duplicate', uploadId: existing.id, refId: existing.refId };
    }
  }

  // 2) Extract with the shared ocean-rate extractor.
  const label =
    (input.filename && input.filename.trim()) ||
    email.subject.trim() ||
    email.from.trim() ||
    'bcc-quote';
  const promptText = parsedEmailToPromptText(email);
  const parsed = await deps.parse(promptText, label);

  // 3) Not a rate quote → persist nothing.
  const rows = sellRowsFromParsed(parsed, label);
  if (!isRateQuote(parsed) || rows.length === 0) {
    return { status: 'not_a_quote' };
  }

  // 4) Persist a synthetic email_bcc upload + its SELL rows.
  const refId = (deps.genRefId ?? emailRefId)();
  const uploadId = await deps.save({
    refId,
    outputFolder: `email-bcc/${refId}`,
    rows,
    rawResults: {
      refId,
      source: 'email_bcc',
      subject: email.subject,
      from: email.from,
      messageId: email.messageId,
    },
    documentType: parsed.document_type,
    sourceType: 'email_bcc',
    sourceMessageId: email.messageId || null,
  });

  return { status: 'ingested', rateCount: rows.length, uploadId, refId };
}

/**
 * Constant-time comparison of the presented token against the configured
 * secret. Length mismatch short-circuits to false without leaking timing via
 * timingSafeEqual's own length check. Empty configured secret ⇒ never matches.
 */
export function tokenMatches(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull the presented token from header / bearer / query, in that order. */
function presentedToken(req: Request): string {
  const header = req.header('x-rate-ingest-token');
  if (header) return header;
  const auth = req.header('authorization') ?? '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1]!.trim();
  const q = req.query?.token;
  if (typeof q === 'string') return q;
  return '';
}

export function registerRateEmailIngestRoute(app: Express): void {
  // Route-scoped raw-text parser for non-JSON bodies (raw MIME). The global
  // express.json() only touches application/json, so a message/rfc822 or
  // text/plain body arrives here unparsed and this captures it as a string.
  const rawText = express.text({
    // The predicate receives a raw IncomingMessage (no req.is); inspect the
    // Content-Type header directly. Everything that is NOT application/json is
    // captured as a raw string (raw MIME / message-rfc822 / text-plain).
    type: (req) =>
      !(req.headers['content-type'] || '').toLowerCase().includes('application/json'),
    limit: '50mb',
  });

  app.post('/api/rates/ingest-email', rawText, async (req: Request, res: Response) => {
    // Auth: a missing/mismatched token (or an unset server secret) 404s — the
    // endpoint's existence is not advertised to an unauthenticated caller.
    const expected = process.env.RATE_EMAIL_INGEST_TOKEN ?? '';
    if (!tokenMatches(presentedToken(req), expected)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    // Body: JSON { raw, filename } or a raw MIME string.
    let raw = '';
    let filename: string | null = null;
    if (req.is('application/json')) {
      const body = (req.body ?? {}) as { raw?: unknown; filename?: unknown };
      raw = typeof body.raw === 'string' ? body.raw : '';
      filename = typeof body.filename === 'string' ? body.filename : null;
    } else {
      raw = typeof req.body === 'string' ? req.body : '';
      const qf = req.query?.filename;
      if (typeof qf === 'string') filename = qf;
    }
    if (!raw.trim()) {
      res.status(400).json({ status: 'error', message: 'Empty email body.' });
      return;
    }

    try {
      const result = await runEmailRateIngest(
        { raw, filename },
        {
          parse: (promptText, label) =>
            parseRateSheet({ text: promptText, filename: label }),
          findByMessageId: findSheetUploadByMessageId,
          save: saveSheetUpload,
        }
      );
      res.status(200).json(result);
    } catch (err) {
      // Never throw to the client: a transient extraction/DB failure is logged
      // and reported cleanly so the forwarder can retry without a stack trace.
      const message = err instanceof Error ? err.message : String(err);
      console.error('[api/rates/ingest-email] ingest failed:', message);
      res.status(502).json({ status: 'error', message });
    }
  });
}
