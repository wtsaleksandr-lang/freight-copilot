import { sqliteTable, integer, text, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const carriers = sqliteTable('carriers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
});

export const quoteBundles = sqliteTable('quote_bundles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  refId: text('ref_id').notNull().unique(),
  outputFolder: text('output_folder').notNull(),
  clientName: text('client_name'),
  intakeText: text('intake_text'),
  intakeImagePath: text('intake_image_path'),
  origin: text('origin').notNull(),
  destination: text('destination').notNull(),
  containerType: text('container_type').notNull(),
  cargoWeightKg: integer('cargo_weight_kg').notNull(),
  commodity: text('commodity'),
  carrierCodes: text('carrier_codes', { mode: 'json' })
    .$type<string[]>()
    .notNull(),
  markupPct: real('markup_pct').notNull().default(0),
  markupFlat: real('markup_flat').notNull().default(0),
  emailTemplate: text('email_template'),
  generatedEmail: text('generated_email'),
  status: text('status').notNull().default('pending'),
  errors: text('errors', { mode: 'json' }).$type<
    Array<{ carrier: string; reason: string }>
  >(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const quotes = sqliteTable('quotes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  origin: text('origin').notNull(),
  destination: text('destination').notNull(),
  containerType: text('container_type').notNull(),
  requestedDate: text('requested_date').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  notes: text('notes'),
  bundleId: integer('bundle_id').references(() => quoteBundles.id, {
    onDelete: 'set null',
  }),
});

/** Stored shape of one charge row. Note: total is in MAJOR units (e.g. dollars, not cents)
 * to match what Maersk shows to the user — easier to debug. */
export type StoredCharge = {
  name: string;
  basis: string | null;
  quantity: number | null;
  unit_price: number | null;
  total: number;
  currency: string;
};

export const rateSnapshots = sqliteTable('rate_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  quoteId: integer('quote_id')
    .notNull()
    .references(() => quotes.id, { onDelete: 'cascade' }),
  carrierId: integer('carrier_id')
    .notNull()
    .references(() => carriers.id),
  serviceName: text('service_name'),
  sailingDate: text('sailing_date'),
  vesselVoyage: text('vessel_voyage'),
  transitDays: integer('transit_days'),
  validUntil: text('valid_until'),
  detentionFreetimeDays: integer('detention_freetime_days'),
  demurrageFreetimeDays: integer('demurrage_freetime_days'),
  rollable: integer('rollable', { mode: 'boolean' }),
  baseFreightCents: integer('base_freight_cents').notNull(),
  /** Itemized "Freight charges" rows (our cost). */
  charges: text('charges', { mode: 'json' }).$type<StoredCharge[]>(),
  /** Itemized "Destination charges" (on-collect, informational). */
  destinationCharges: text('destination_charges', { mode: 'json' }).$type<StoredCharge[]>(),
  totalCostCents: integer('total_cost_cents').notNull(),
  currency: text('currency').notNull(),
  destinationTotal: integer('destination_total'),
  destinationCurrency: text('destination_currency'),
  headlineMismatch: integer('headline_mismatch', { mode: 'boolean' }),
  rawHtmlRef: text('raw_html_ref'),
  parsedAt: integer('parsed_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  rank: integer('rank'),
});

export const sessions = sqliteTable('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  carrierId: integer('carrier_id')
    .notNull()
    .references(() => carriers.id)
    .unique(),
  storageState: text('storage_state', { mode: 'json' }).notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
});
