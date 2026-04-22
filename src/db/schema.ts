import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const carriers = sqliteTable('carriers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
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
});

export type RateCharge = { name: string; amountCents: number };

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
  transitDays: integer('transit_days'),
  validUntil: text('valid_until'),
  baseFreightCents: integer('base_freight_cents').notNull(),
  charges: text('charges', { mode: 'json' }).$type<RateCharge[]>(),
  totalCostCents: integer('total_cost_cents').notNull(),
  currency: text('currency').notNull(),
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
