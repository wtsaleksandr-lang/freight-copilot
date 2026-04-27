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

/**
 * Drayage = port ↔ address container truck moves.
 * Foundation table — rate sources (provider rate sheets, APIs, marketplaces)
 * are wired in later. The schema is broad enough to cover both
 * import drayage (port → consignee) and export drayage (shipper → port).
 */
export const drayageQuotes = sqliteTable('drayage_quotes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  refId: text('ref_id').notNull().unique(),
  outputFolder: text('output_folder').notNull(),
  /** 'import' = port → address; 'export' = address → port. */
  direction: text('direction').notNull(),
  portCode: text('port_code').notNull(),
  portName: text('port_name'),
  addressLine1: text('address_line1').notNull(),
  city: text('city').notNull(),
  state: text('state'),
  zip: text('zip'),
  country: text('country').notNull().default('US'),
  containerType: text('container_type').notNull(),
  containerCount: integer('container_count').notNull().default(1),
  weightKg: integer('weight_kg'),
  pickupDate: text('pickup_date'),
  deliveryDate: text('delivery_date'),
  /** chassis, gen-set, hazmat, overweight permit, tri-axle, etc. */
  specialEquipment: text('special_equipment', { mode: 'json' }).$type<string[]>(),
  /** prepull, storage, detention notes. */
  accessorials: text('accessorials', { mode: 'json' }).$type<string[]>(),
  clientName: text('client_name'),
  notes: text('notes'),
  markupPct: real('markup_pct').notNull().default(0),
  markupFlat: real('markup_flat').notNull().default(0),
  status: text('status').notNull().default('pending'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const drayageRates = sqliteTable('drayage_rates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  drayageQuoteId: integer('drayage_quote_id')
    .notNull()
    .references(() => drayageQuotes.id, { onDelete: 'cascade' }),
  providerName: text('provider_name').notNull(),
  providerCode: text('provider_code'),
  /** Itemized charges (line haul, fuel surcharge, chassis, etc.). */
  charges: text('charges', { mode: 'json' }).$type<StoredCharge[]>(),
  baseRateCents: integer('base_rate_cents').notNull(),
  totalCostCents: integer('total_cost_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  transitDays: integer('transit_days'),
  validUntil: text('valid_until'),
  freeTimeDays: integer('free_time_days'),
  /** Path to PDF / screenshot / sheet that backs this rate. */
  rawSourcePath: text('raw_source_path'),
  notes: text('notes'),
  rank: integer('rank'),
  parsedAt: integer('parsed_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Trucking = ground freight without an ocean container (dryvan, flatbed, reefer,
 * step deck, etc.). Both FTL and LTL.
 */
export const truckingQuotes = sqliteTable('trucking_quotes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  refId: text('ref_id').notNull().unique(),
  outputFolder: text('output_folder').notNull(),
  /** 'ftl' or 'ltl'. */
  mode: text('mode').notNull().default('ftl'),
  pickupAddressLine1: text('pickup_address_line1').notNull(),
  pickupCity: text('pickup_city').notNull(),
  pickupState: text('pickup_state'),
  pickupZip: text('pickup_zip'),
  pickupCountry: text('pickup_country').notNull().default('US'),
  deliveryAddressLine1: text('delivery_address_line1').notNull(),
  deliveryCity: text('delivery_city').notNull(),
  deliveryState: text('delivery_state'),
  deliveryZip: text('delivery_zip'),
  deliveryCountry: text('delivery_country').notNull().default('US'),
  /** dryvan, flatbed, reefer, step_deck, conestoga, hotshot, etc. */
  equipmentType: text('equipment_type').notNull(),
  weightKg: integer('weight_kg'),
  lengthFt: real('length_ft'),
  widthFt: real('width_ft'),
  heightFt: real('height_ft'),
  pieces: integer('pieces'),
  hazmat: integer('hazmat', { mode: 'boolean' }).default(false),
  tempControlled: integer('temp_controlled', { mode: 'boolean' }).default(false),
  tempMinF: real('temp_min_f'),
  tempMaxF: real('temp_max_f'),
  pickupDate: text('pickup_date'),
  deliveryDate: text('delivery_date'),
  commodity: text('commodity'),
  clientName: text('client_name'),
  notes: text('notes'),
  markupPct: real('markup_pct').notNull().default(0),
  markupFlat: real('markup_flat').notNull().default(0),
  status: text('status').notNull().default('pending'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const truckingRates = sqliteTable('trucking_rates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  truckingQuoteId: integer('trucking_quote_id')
    .notNull()
    .references(() => truckingQuotes.id, { onDelete: 'cascade' }),
  providerName: text('provider_name').notNull(),
  providerCode: text('provider_code'),
  charges: text('charges', { mode: 'json' }).$type<StoredCharge[]>(),
  baseRateCents: integer('base_rate_cents').notNull(),
  totalCostCents: integer('total_cost_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  transitDays: integer('transit_days'),
  ratePerMile: real('rate_per_mile'),
  totalMiles: integer('total_miles'),
  validUntil: text('valid_until'),
  rawSourcePath: text('raw_source_path'),
  notes: text('notes'),
  rank: integer('rank'),
  parsedAt: integer('parsed_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
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
