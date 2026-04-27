import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDbClient } from './client.js';
import {
  quoteBundles,
  quotes,
  rateSnapshots,
  carriers as carriersTable,
} from './schema.js';
import { getCarrier } from '../carriers/registry.js';
import { parseRates } from '../llm/parseRates.js';
import { rankRates } from '../ranker/rankRates.js';
import type { RankedRateOption } from '../types.js';
import { CaptchaBlockedError, type CaptchaType } from '../captcha/types.js';

export type EndType = 'CY' | 'DOOR';
export type CargoType = 'general' | 'hazmat' | 'high_value' | 'reefer';

export interface BundleEnd {
  type: EndType;
  portCode?: string;
  portName?: string;
  terminal?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

export interface RunBundleInput {
  carrierCodes: string[];
  /** Legacy display fields — kept because Maersk's autocomplete uses them today. */
  origin: string;
  originRegion?: string;
  destination: string;
  destinationRegion?: string;
  /** Structured cargo + endpoints (V1: stored, not yet driven into Maersk's "I want pickup at facility" radio). */
  cargoType?: CargoType;
  originStruct?: BundleEnd;
  destinationStruct?: BundleEnd;
  containerType: string;
  cargoWeightKg: number;
  commodity?: string;
  clientName?: string;
  markupPct: number;
  markupFlat: number;
  emailTemplate?: string;
  intakeText?: string;
}

export interface CarrierResult {
  carrierCode: string;
  carrierName: string;
  status: 'ok' | 'skipped' | 'failed' | 'captcha_blocked';
  reason?: string;
  /** When status === 'captcha_blocked', the type of captcha we detected. */
  captchaType?: CaptchaType;
  ranked: RankedRateOption[];
  artifacts?: { screenshot: string; html: string; ariaTree: string };
}

export interface BundleResult {
  bundleId: number;
  refId: string;
  outputFolder: string;
  carriers: CarrierResult[];
  /** Best rate across all carriers, with the carrier label tagged on. */
  bestOverall:
    | (RankedRateOption & { carrierCode: string; carrierName: string })
    | null;
  generatedEmail: string;
  status: 'complete' | 'partial' | 'failed';
}

/** Q-YYYYMMDD-XXXX where XXXX is 4 alphanumeric chars. */
function generateRefId(): string {
  const date = new Date();
  const yyyymmdd = date.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `Q-${yyyymmdd}-${rand}`;
}

export async function runQuoteBundle(
  input: RunBundleInput
): Promise<BundleResult> {
  const refId = generateRefId();
  const outputFolder = resolve('./quotes', refId);
  await mkdir(outputFolder, { recursive: true });
  await mkdir(resolve(outputFolder, 'rates'), { recursive: true });

  const db = createDbClient();

  const o = input.originStruct;
  const d = input.destinationStruct;
  const [bundle] = await db
    .insert(quoteBundles)
    .values({
      refId,
      outputFolder,
      clientName: input.clientName ?? null,
      intakeText: input.intakeText ?? null,
      origin: input.origin,
      destination: input.destination,
      cargoType: input.cargoType ?? 'general',
      originType: o?.type ?? 'CY',
      originPortCode: o?.portCode ?? null,
      originPortName: o?.portName ?? null,
      originTerminal: o?.terminal ?? null,
      originAddressLine1: o?.addressLine1 ?? null,
      originCity: o?.city ?? null,
      originState: o?.state ?? null,
      originZip: o?.zip ?? null,
      originCountry: o?.country ?? null,
      destinationType: d?.type ?? 'CY',
      destinationPortCode: d?.portCode ?? null,
      destinationPortName: d?.portName ?? null,
      destinationTerminal: d?.terminal ?? null,
      destinationAddressLine1: d?.addressLine1 ?? null,
      destinationCity: d?.city ?? null,
      destinationState: d?.state ?? null,
      destinationZip: d?.zip ?? null,
      destinationCountry: d?.country ?? null,
      containerType: input.containerType,
      cargoWeightKg: input.cargoWeightKg,
      commodity: input.commodity ?? null,
      carrierCodes: input.carrierCodes,
      markupPct: input.markupPct,
      markupFlat: input.markupFlat,
      emailTemplate: input.emailTemplate ?? null,
      status: 'pending',
    })
    .returning({ id: quoteBundles.id });
  if (!bundle) throw new Error('Failed to insert bundle');

  if (input.intakeText) {
    await writeFile(resolve(outputFolder, 'intake.txt'), input.intakeText);
  }

  const carrierResults: CarrierResult[] = [];
  const errors: Array<{ carrier: string; reason: string }> = [];
  const allRanked: Array<RankedRateOption & { carrierCode: string }> = [];

  for (const code of input.carrierCodes) {
    let carrier;
    try {
      carrier = getCarrier(code);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown carrier';
      errors.push({ carrier: code, reason });
      carrierResults.push({
        carrierCode: code,
        carrierName: code,
        status: 'failed',
        reason,
        ranked: [],
      });
      continue;
    }

    if (!carrier.isActive) {
      carrierResults.push({
        carrierCode: code,
        carrierName: carrier.name,
        status: 'skipped',
        reason: 'onboarding pending',
        ranked: [],
      });
      continue;
    }

    try {
      console.log(`[bundle ${refId}] Fetching ${carrier.name}...`);
      const fetchResult = await carrier.fetchRates({
        origin: input.origin,
        originRegion: input.originRegion,
        destination: input.destination,
        destinationRegion: input.destinationRegion,
        containerType: input.containerType,
        cargoWeightKg: input.cargoWeightKg,
        commodity: input.commodity,
      });

      const codeFs = code.toLowerCase();
      const screenshotDest = resolve(
        outputFolder,
        'rates',
        `${codeFs}-screenshot.png`
      );
      const htmlDest = resolve(outputFolder, 'rates', `${codeFs}-page.html`);
      const yamlDest = resolve(outputFolder, 'rates', `${codeFs}-aria.yaml`);
      await copyFile(fetchResult.screenshotPath, screenshotDest).catch(() => {});
      await copyFile(fetchResult.htmlPath, htmlDest).catch(() => {});
      await copyFile(fetchResult.ariaTreePath, yamlDest).catch(() => {});

      const rates = await parseRates(fetchResult.sailingsAriaTree);
      const ranked = rankRates(rates);

      await writeFile(
        resolve(outputFolder, 'rates', `${codeFs}-parsed.json`),
        JSON.stringify({ rates, ranked }, null, 2)
      );

      // Persist quote + rate_snapshots
      const [carrierRow] = await db
        .select()
        .from(carriersTable)
        .where(eq(carriersTable.code, code));
      if (carrierRow) {
        const [quoteRow] = await db
          .insert(quotes)
          .values({
            origin: input.origin,
            destination: input.destination,
            containerType: input.containerType,
            requestedDate: new Date().toISOString().slice(0, 10),
            bundleId: bundle.id,
          })
          .returning({ id: quotes.id });
        if (quoteRow && ranked.length > 0) {
          await db.insert(rateSnapshots).values(
            ranked.map((r) => {
              const cents = Math.round(r.freight_total * 100);
              return {
                quoteId: quoteRow.id,
                carrierId: carrierRow.id,
                serviceName: r.service_name,
                sailingDate: r.sailing_date,
                vesselVoyage: r.vessel_voyage,
                transitDays: r.transit_days,
                detentionFreetimeDays: r.detention_freetime_days,
                demurrageFreetimeDays: r.demurrage_freetime_days,
                rollable: r.rollable,
                baseFreightCents: cents,
                charges: r.freight_charges.map((c) => ({
                  name: c.name,
                  basis: c.basis,
                  quantity: c.quantity,
                  unit_price: c.unit_price,
                  total: c.total,
                  currency: c.currency,
                })),
                destinationCharges: r.destination_charges.map((c) => ({
                  name: c.name,
                  basis: c.basis,
                  quantity: c.quantity,
                  unit_price: c.unit_price,
                  total: c.total,
                  currency: c.currency,
                })),
                totalCostCents: cents,
                currency: r.freight_currency,
                destinationTotal: r.destination_total || null,
                destinationCurrency: r.destination_currency,
                headlineMismatch: r.headline_mismatch,
                rawHtmlRef: htmlDest,
                rank: r.rank,
              };
            })
          );
        }
      }

      carrierResults.push({
        carrierCode: code,
        carrierName: carrier.name,
        status: 'ok',
        ranked,
        artifacts: {
          screenshot: screenshotDest,
          html: htmlDest,
          ariaTree: yamlDest,
        },
      });
      for (const r of ranked) allRanked.push({ ...r, carrierCode: code });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof CaptchaBlockedError) {
        console.warn(
          `[bundle ${refId}] ${code} captcha-blocked (${err.captchaType}); skipping & continuing.`
        );
        errors.push({ carrier: code, reason: `captcha: ${err.captchaType}` });
        carrierResults.push({
          carrierCode: code,
          carrierName: carrier.name,
          status: 'captcha_blocked',
          reason: `${err.captchaType} — solve manually next time, or configure a captcha solver`,
          captchaType: err.captchaType,
          ranked: [],
        });
      } else {
        console.error(`[bundle ${refId}] ${code} failed:`, reason);
        errors.push({ carrier: code, reason });
        carrierResults.push({
          carrierCode: code,
          carrierName: carrier.name,
          status: 'failed',
          reason,
          ranked: [],
        });
      }
    }
  }

  // Best rate across all carriers
  const sortedAll = [...allRanked].sort((a, b) => a.freight_total - b.freight_total);
  let bestOverall:
    | (RankedRateOption & { carrierCode: string; carrierName: string })
    | null = null;
  if (sortedAll.length > 0) {
    const best = sortedAll[0]!;
    const carrier = getCarrier(best.carrierCode);
    bestOverall = { ...best, carrierName: carrier.name };
  }

  const okCount = carrierResults.filter((r) => r.status === 'ok').length;
  const status: 'complete' | 'partial' | 'failed' =
    okCount === carrierResults.length && okCount > 0
      ? 'complete'
      : okCount > 0
        ? 'partial'
        : 'failed';

  // Save summary
  const summary = {
    refId,
    bundleId: bundle.id,
    outputFolder,
    input,
    carrierResults,
    bestOverall,
    status,
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    resolve(outputFolder, 'summary.json'),
    JSON.stringify(summary, null, 2)
  );

  await db
    .update(quoteBundles)
    .set({
      status,
      errors: errors.length > 0 ? errors : null,
    })
    .where(eq(quoteBundles.id, bundle.id));

  return {
    bundleId: bundle.id,
    refId,
    outputFolder,
    carriers: carrierResults,
    bestOverall,
    generatedEmail: '', // filled in after generateBundleEmail() is called
    status,
  };
}

export async function saveGeneratedEmail(
  bundleId: number,
  refId: string,
  outputFolder: string,
  email: string
): Promise<void> {
  const db = createDbClient();
  await writeFile(resolve(outputFolder, 'client-reply.txt'), email);
  await db
    .update(quoteBundles)
    .set({ generatedEmail: email })
    .where(eq(quoteBundles.id, bundleId));
  void refId; // for log alignment
}
