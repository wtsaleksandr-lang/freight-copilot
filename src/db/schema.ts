import { pgTable, integer, serial, text, doublePrecision, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';

export const carriers = pgTable('carriers', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
});

export const quoteBundles = pgTable('quote_bundles', {
  id: serial('id').primaryKey(),
  refId: text('ref_id').notNull().unique(),
  outputFolder: text('output_folder').notNull(),
  clientName: text('client_name'),
  intakeText: text('intake_text'),
  intakeImagePath: text('intake_image_path'),

  /** Legacy / display fields — origin and destination as user typed (city/port name). */
  origin: text('origin').notNull(),
  destination: text('destination').notNull(),

  /** New: explicit cargo type. */
  cargoType: text('cargo_type').notNull().default('general'),

  /** New: structured origin/destination — CY (port) or DOOR (address). */
  originType: text('origin_type').notNull().default('CY'),
  originPortCode: text('origin_port_code'),
  originPortName: text('origin_port_name'),
  originTerminal: text('origin_terminal'),
  originAddressLine1: text('origin_address_line1'),
  originCity: text('origin_city'),
  originState: text('origin_state'),
  originZip: text('origin_zip'),
  originCountry: text('origin_country'),

  destinationType: text('destination_type').notNull().default('CY'),
  destinationPortCode: text('destination_port_code'),
  destinationPortName: text('destination_port_name'),
  destinationTerminal: text('destination_terminal'),
  destinationAddressLine1: text('destination_address_line1'),
  destinationCity: text('destination_city'),
  destinationState: text('destination_state'),
  destinationZip: text('destination_zip'),
  destinationCountry: text('destination_country'),

  containerType: text('container_type').notNull(),
  cargoWeightKg: integer('cargo_weight_kg').notNull(),
  commodity: text('commodity'),
  carrierCodes: jsonb('carrier_codes')
    .$type<string[]>()
    .notNull(),
  markupPct: doublePrecision('markup_pct').notNull().default(0),
  markupFlat: doublePrecision('markup_flat').notNull().default(0),
  emailTemplate: text('email_template'),
  generatedEmail: text('generated_email'),
  status: text('status').notNull().default('pending'),
  errors: jsonb('errors').$type<
    Array<{ carrier: string; reason: string }>
  >(),
  createdAt: timestamp('created_at', { mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const quotes = pgTable('quotes', {
  id: serial('id').primaryKey(),
  origin: text('origin').notNull(),
  destination: text('destination').notNull(),
  containerType: text('container_type').notNull(),
  requestedDate: text('requested_date').notNull(),
  createdAt: timestamp('created_at', { mode: 'date' })
    .notNull()
    .defaultNow(),
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

export const rateSnapshots = pgTable('rate_snapshots', {
  id: serial('id').primaryKey(),
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
  rollable: boolean('rollable'),
  baseFreightCents: integer('base_freight_cents').notNull(),
  /** Itemized "Freight charges" rows (our cost). */
  charges: jsonb('charges').$type<StoredCharge[]>(),
  /** Itemized "Destination charges" (on-collect, informational). */
  destinationCharges: jsonb('destination_charges').$type<StoredCharge[]>(),
  totalCostCents: integer('total_cost_cents').notNull(),
  currency: text('currency').notNull(),
  destinationTotal: integer('destination_total'),
  destinationCurrency: text('destination_currency'),
  headlineMismatch: boolean('headline_mismatch'),
  rawHtmlRef: text('raw_html_ref'),
  parsedAt: timestamp('parsed_at', { mode: 'date' })
    .notNull()
    .defaultNow(),
  rank: integer('rank'),
});

/**
 * Drayage = port ↔ address container truck moves.
 * Foundation table — rate sources (provider rate sheets, APIs, marketplaces)
 * are wired in later. The schema is broad enough to cover both
 * import drayage (port → consignee) and export drayage (shipper → port).
 */
export const drayageQuotes = pgTable('drayage_quotes', {
  id: serial('id').primaryKey(),
  refId: text('ref_id').notNull().unique(),
  outputFolder: text('output_folder').notNull(),

  /** 'general' | 'hazmat' | 'high_value' | 'reefer' (extend later) */
  cargoType: text('cargo_type').notNull().default('general'),
  containerType: text('container_type').notNull(),
  containerCount: integer('container_count').notNull().default(1),
  weightKg: integer('weight_kg'),

  /** 'CY' (container yard / port terminal) | 'DOOR' (street address) */
  originType: text('origin_type').notNull(),
  originPortCode: text('origin_port_code'),
  originPortName: text('origin_port_name'),
  originTerminal: text('origin_terminal'),
  originAddressLine1: text('origin_address_line1'),
  originCity: text('origin_city'),
  originState: text('origin_state'),
  originZip: text('origin_zip'),
  originCountry: text('origin_country'),

  destinationType: text('destination_type').notNull(),
  destinationPortCode: text('destination_port_code'),
  destinationPortName: text('destination_port_name'),
  destinationTerminal: text('destination_terminal'),
  destinationAddressLine1: text('destination_address_line1'),
  destinationCity: text('destination_city'),
  destinationState: text('destination_state'),
  destinationZip: text('destination_zip'),
  destinationCountry: text('destination_country'),

  pickupDate: text('pickup_date'),
  deliveryDate: text('delivery_date'),
  specialEquipment: jsonb('special_equipment').$type<string[]>(),
  accessorials: jsonb('accessorials').$type<string[]>(),
  clientName: text('client_name'),
  notes: text('notes'),
  markupPct: doublePrecision('markup_pct').notNull().default(0),
  markupFlat: doublePrecision('markup_flat').notNull().default(0),
  status: text('status').notNull().default('pending'),
  /** Raw text/screenshot the user pasted as intake (kept for audit). */
  intakeText: text('intake_text'),
  createdAt: timestamp('created_at', { mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const drayageRates = pgTable('drayage_rates', {
  id: serial('id').primaryKey(),
  drayageQuoteId: integer('drayage_quote_id')
    .notNull()
    .references(() => drayageQuotes.id, { onDelete: 'cascade' }),
  providerName: text('provider_name').notNull(),
  providerCode: text('provider_code'),
  /** Itemized charges (line haul, fuel surcharge, chassis, etc.). */
  charges: jsonb('charges').$type<StoredCharge[]>(),
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
  parsedAt: timestamp('parsed_at', { mode: 'date' })
    .notNull()
    .defaultNow(),
});

/**
 * Trucking = ground freight without an ocean container (dryvan, flatbed, reefer,
 * step deck, etc.). Both FTL and LTL.
 */
export const truckingQuotes = pgTable('trucking_quotes', {
  id: serial('id').primaryKey(),
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
  /** 'general' | 'hazmat' | 'high_value' | 'reefer' */
  cargoType: text('cargo_type').notNull().default('general'),
  /** dryvan, flatbed, reefer, step_deck, conestoga, hotshot, etc. */
  equipmentType: text('equipment_type').notNull(),
  weightKg: integer('weight_kg'),
  lengthFt: doublePrecision('length_ft'),
  widthFt: doublePrecision('width_ft'),
  heightFt: doublePrecision('height_ft'),
  pieces: integer('pieces'),
  hazmat: boolean('hazmat').default(false),
  tempControlled: boolean('temp_controlled').default(false),
  tempMinF: doublePrecision('temp_min_f'),
  tempMaxF: doublePrecision('temp_max_f'),
  pickupDate: text('pickup_date'),
  deliveryDate: text('delivery_date'),
  commodity: text('commodity'),
  clientName: text('client_name'),
  notes: text('notes'),
  markupPct: doublePrecision('markup_pct').notNull().default(0),
  markupFlat: doublePrecision('markup_flat').notNull().default(0),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const truckingRates = pgTable('trucking_rates', {
  id: serial('id').primaryKey(),
  truckingQuoteId: integer('trucking_quote_id')
    .notNull()
    .references(() => truckingQuotes.id, { onDelete: 'cascade' }),
  providerName: text('provider_name').notNull(),
  providerCode: text('provider_code'),
  charges: jsonb('charges').$type<StoredCharge[]>(),
  baseRateCents: integer('base_rate_cents').notNull(),
  totalCostCents: integer('total_cost_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  transitDays: integer('transit_days'),
  ratePerMile: doublePrecision('rate_per_mile'),
  totalMiles: integer('total_miles'),
  validUntil: text('valid_until'),
  rawSourcePath: text('raw_source_path'),
  notes: text('notes'),
  rank: integer('rank'),
  parsedAt: timestamp('parsed_at', { mode: 'date' })
    .notNull()
    .defaultNow(),
});

/**
 * Parsed-sheet history. One row in sheet_uploads per Sheets-tab parse
 * event, with N rows in sheet_rates (one per lane × container).
 * Lets the user search past quotes by POL/POD without re-running Claude
 * over the same screenshots.
 */
export const sheetUploads = pgTable('sheet_uploads', {
  id: serial('id').primaryKey(),
  refId: text('ref_id').notNull().unique(),
  outputFolder: text('output_folder').notNull(),
  /** Most recently generated email body (replaces on each /api/sheets/reply). */
  generatedEmail: text('generated_email'),
  markupPct: doublePrecision('markup_pct').notNull().default(0),
  markupFlat: doublePrecision('markup_flat').notNull().default(0),
  addExportDeclaration: boolean('add_export_declaration')
    .notNull()
    .default(false),
  exportDeclarationFee: doublePrecision('export_declaration_fee').notNull().default(0),
  /** Whatever JSON the original parse_sheet endpoint returned (keep for replay). */
  rawResultsJson: jsonb('raw_results_json').$type<unknown>(),
  /** AI classification of the dropped file: rate_sheet | quote_request | other. */
  documentType: text('document_type'),
  /** Storage key of the kept ORIGINAL file, or null when it was discarded. */
  keptStorageKey: text('kept_storage_key'),
  /** Backend the kept original lives in: 'r2' | 'disk' (null when discarded). */
  keptBackend: text('kept_backend'),
  createdAt: timestamp('created_at', { mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const sheetRates = pgTable('sheet_rates', {
  id: serial('id').primaryKey(),
  uploadId: integer('upload_id')
    .notNull()
    .references(() => sheetUploads.id, { onDelete: 'cascade' }),
  carrierCode: text('carrier_code').notNull(),
  pol: text('pol').notNull(),
  polCode: text('pol_code'),
  pod: text('pod').notNull(),
  podCode: text('pod_code'),
  containerType: text('container_type').notNull(),
  transitDays: integer('transit_days'),
  detentionFreetimeDays: integer('detention_freetime_days'),
  demurrageFreetimeDays: integer('demurrage_freetime_days'),
  freightTotal: doublePrecision('freight_total').notNull(),
  freightCurrency: text('freight_currency').notNull(),
  freightCharges: jsonb('freight_charges').$type<
    Array<{ name: string; amount: number; currency: string }>
  >(),
  destinationTotal: doublePrecision('destination_total'),
  destinationCurrency: text('destination_currency'),
  destinationCharges: jsonb('destination_charges').$type<
    Array<{ name: string; amount: number; currency: string }>
  >(),
  validityFrom: text('validity_from'),
  validityTo: text('validity_to'),
  serviceName: text('service_name'),
  sourceFilename: text('source_filename'),
  /** URL path under /parsed-sheets-files for the dashboard to link/preview. */
  sourceUrl: text('source_url'),
  /** Pre-lowered concat of pol/polCode/pod/podCode for fast search. */
  searchKey: text('search_key').notNull(),
});

/**
 * Personal shipment board. One row per booked / in-progress shipment.
 * Ref id pattern: S00001, S00002 … (zero-padded 5-digit counter).
 * Cells are editable inline in the dashboard; AI extraction from email
 * screenshots / PDFs pre-fills new rows.
 */
export const shipments = pgTable('shipments', {
  id: serial('id').primaryKey(),
  refId: text('ref_id').notNull().unique(),
  createdAt: timestamp('created_at', { mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .notNull()
    .defaultNow(),
  shipperName: text('shipper_name'),
  receiverName: text('receiver_name'),
  customerName: text('customer_name'),
  loadingAddress: text('loading_address'),
  /** First port of loading — used for inland origins (Kansas City,
   *  Chicago, etc.) where there's a rail/road leg before the actual
   *  ocean POL. Distinct from `pol` which is the ocean port itself. */
  fpol: text('fpol'),
  fpolCode: text('fpol_code'),
  pol: text('pol'),
  polCode: text('pol_code'),
  pod: text('pod'),
  podCode: text('pod_code'),
  containerType: text('container_type'),
  /** How many containers in this shipment (e.g. "3 x 40HC" → 3).
   *  When set, every per-container line item in costBreakdownJson is
   *  expected to ALREADY be multiplied by this quantity (the AI does
   *  the math at extraction time so the breakdown sums to the all-in
   *  total). Used by the UI to display "(x N)" next to container_type. */
  containerQuantity: integer('container_quantity'),
  cargoType: text('cargo_type'),
  cargoName: text('cargo_name'),
  soldRate: doublePrecision('sold_rate'),
  soldCurrency: text('sold_currency').default('USD'),
  /** Same shape as costBreakdownJson but for the sell side — line
   *  items the customer is being charged (base ocean freight, export
   *  declaration fee, customer-side markup, etc.). soldRate equals
   *  the sum of these items + any manual delta the user has typed. */
  soldBreakdownJson: jsonb('sold_breakdown_json').$type<
    Array<{
      name: string;
      amount: number;
      currency: string;
      sourceFile?: string | null;
      addedAt?: string;
    }>
  >(),
  /** Total cost paid to ocean carrier / inland / etc. — sum of every
   *  line item in costBreakdownJson. AI accumulates this across all
   *  files dropped onto the row. Estimated profit = soldRate - ourCost
   *  (computed at render time, not stored). */
  ourCost: doublePrecision('our_cost'),
  ourCostCurrency: text('our_cost_currency').default('USD'),
  costBreakdownJson: jsonb('cost_breakdown_json').$type<
    Array<{
      name: string;
      amount: number;
      currency: string;
      sourceFile?: string | null;
      addedAt?: string;
    }>
  >(),
  carrierPreference: text('carrier_preference'),
  /** Carrier booking reference (e.g. MSC-218754, MAEU-9032111). Stored
   *  separately from refId because it's the carrier's number, not ours. */
  bookingRef: text('booking_ref'),
  /** FCL / LCL / Road — shipment mode (extracted by AI when explicit in
   *  the email, otherwise null and editable inline). */
  shipmentType: text('shipment_type'),
  /** User-managed operational status: shipped / processing /
   *  pending_invoice / pending_payment / null. Drives the colored dot
   *  in the Status column. Independent of DelayPredict's tracking
   *  status (which lives in shipment.tracking at render time). */
  operationalStatus: text('operational_status'),
  notes: text('notes'),
  /** JSON list of uploaded source files (paths under /shipments-files/...).
   *  addedAt is a server-stamped ISO timestamp; missing on legacy rows. */
  artifactsJson: jsonb('artifacts_json').$type<
    Array<{
      filename: string;
      url: string;
      mediaType: string;
      addedAt?: string;
    }>
  >(),
});

/**
 * Drayage rate library — the user's archive of provider rate sheets.
 * Distinct from `drayageQuotes` (which is the request side): this is
 * a flat catalogue of every lane × container × surcharge bundle the
 * user has ever uploaded. New entries are APPENDED on every parse —
 * old rates are never replaced — so the user can see price history
 * for the same lane over time.
 *
 * One physical PDF / screenshot / email can yield many rows here
 * (multi-lane rate sheets are common).
 *
 * Lookup pattern: filter by pickup city/state and delivery city/state
 * + container type to find historical rates for a lane.
 */
export const drayageRateLibrary = pgTable('drayage_rate_library', {
  id: serial('id').primaryKey(),
  /** When the user uploaded the source file (server timestamp). */
  createdAt: timestamp('created_at', { mode: 'date' })
    .notNull()
    .defaultNow(),
  /** Date the rate was quoted / valid (extracted by AI from the doc).
   *  ISO date string (YYYY-MM-DD) for cheap range queries. */
  rateDate: text('rate_date'),
  /** Provider / vendor name (e.g. "Hub Group", "STG Logistics"). */
  providerName: text('provider_name'),
  /** Pickup origin — full breakdown so we can filter by city / state. */
  pickupAddress: text('pickup_address'),
  pickupCity: text('pickup_city'),
  pickupState: text('pickup_state'),
  pickupZip: text('pickup_zip'),
  pickupCountry: text('pickup_country').default('US'),
  /** Pickup as one display line, e.g. "Newark, NJ — APM Terminal". */
  pickupLabel: text('pickup_label'),
  /** Delivery destination. */
  deliveryAddress: text('delivery_address'),
  deliveryCity: text('delivery_city'),
  deliveryState: text('delivery_state'),
  deliveryZip: text('delivery_zip'),
  deliveryCountry: text('delivery_country').default('US'),
  deliveryLabel: text('delivery_label'),
  /** Total quoted mileage (one-way). */
  totalMiles: doublePrecision('total_miles'),
  /** Container type (40HC / 20GP / etc). */
  containerType: text('container_type'),
  /** Max cargo weight allowed at this rate (in kg). */
  maxWeightKg: doublePrecision('max_weight_kg'),
  /** Base linehaul rate in USD (after FX conversion). */
  baseRate: doublePrecision('base_rate'),
  /** All-in total in USD = base + sum(surcharges). */
  totalRate: doublePrecision('total_rate'),
  /** Itemised surcharges (FSC, chassis, prepull, detention, etc.). */
  surchargesJson: jsonb('surcharges_json').$type<
    Array<{ name: string; amount: number; currency: string }>
  >(),
  /** Currency the AMOUNTS were originally in — informational; storage
   *  is always USD because of the FX normalisation in the route layer. */
  sourceCurrency: text('source_currency').default('USD'),
  /** Free-form notes from the AI extraction (validity period,
   *  conditions, etc.). */
  notes: text('notes'),
  /** URL of the original file we extracted from, under
   *  /drayage-rates-files/<id>/<filename>. */
  sourceUrl: text('source_url'),
  sourceFilename: text('source_filename'),
  /** Pre-lowered concat of pickup + delivery + cntr for fast LIKE search. */
  searchKey: text('search_key').notNull().default(''),
});

/**
 * Carrier portal login credentials. Vault-only — the system does not type
 * these into login forms. They're stored here so the user can keep them in
 * one place across devices, copy-paste them when logging in, and not have
 * to remember them. Passwords are AES-256-GCM encrypted via secretsCrypto.
 */
/**
 * Scheduled web-agent tasks. Background tick runs every minute,
 * launches any task whose lastRunAt is older than intervalMinutes
 * and which is enabled. Stores last-run status + a short result
 * blob so the dashboard can show "ran 12m ago, succeeded".
 */
export const scheduledAgents = pgTable('scheduled_agents', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  goal: text('goal').notNull(),
  /** How often to run, in minutes. Min 5, default 60. */
  intervalMinutes: integer('interval_minutes').notNull().default(60),
  /** When false, the tick loop skips this entry. */
  enabled: boolean('enabled').notNull().default(true),
  maxIterations: integer('max_iterations').notNull().default(25),
  lastRunAt: timestamp('last_run_at', { mode: 'date' }),
  lastRunStatus: text('last_run_status'),
  /** Capped to ~2KB of stringified summary. */
  lastRunResult: text('last_run_result'),
  createdAt: timestamp('created_at', { mode: 'date' })
    .notNull()
    .defaultNow(),
});

/**
 * Generic app-settings key/value store. Used for runtime config the
 * user can change from the dashboard (no .env editing): AI_PROVIDER,
 * AI_MODEL, AI_MODEL_FALLBACK, etc. DB values take precedence over
 * env vars; missing keys fall through to env defaults in config.ts.
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .notNull()
    .defaultNow(),
});

/**
 * API keys for third-party AI providers, stored encrypted at rest
 * (same AES-256-GCM scheme as carrier credentials). Read by
 * loadAiKey() in credentialsService.ts; takes precedence over the
 * matching env var when both are set.
 *
 * provider values:
 *   'anthropic' — ANTHROPIC_API_KEY equivalent
 *   'gemini'    — GEMINI_API_KEY equivalent
 *   'openai'    — OPENAI_API_KEY equivalent (future)
 *   'deepseek'  — DEEPSEEK_API_KEY equivalent (future)
 *   'grok'      — XAI_API_KEY equivalent (future)
 */
export const apiKeys = pgTable('api_keys', {
  id: serial('id').primaryKey(),
  provider: text('provider').notNull().unique(),
  /** "iv:tag:ct" base64 segments — same shape as passwordEncrypted. */
  keyEncrypted: text('key_encrypted').notNull(),
  /** Optional label so the user can remember which account/project. */
  label: text('label'),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const carrierCredentials = pgTable('carrier_credentials', {
  id: serial('id').primaryKey(),
  carrierCode: text('carrier_code').notNull().unique(),
  username: text('username').notNull(),
  /** "iv:tag:ct" base64 segments. */
  passwordEncrypted: text('password_encrypted').notNull(),
  notes: text('notes'),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: serial('id').primaryKey(),
  carrierId: integer('carrier_id')
    .notNull()
    .references(() => carriers.id)
    .unique(),
  storageState: jsonb('storage_state').notNull(),
  lastUsedAt: timestamp('last_used_at', { mode: 'date' })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
});

/**
 * Append-only audit trail for credential- and AI-configuration events.
 *
 * SECURITY: never stores a key value, fragment, plaintext password, or
 * ciphertext — only the event type, provider name, source, outcome, and a
 * human-readable sanitized message. Standalone table with NO foreign keys to
 * business tables, so it is purely additive and safe to add/remove.
 */
export const auditEvents = pgTable('audit_events', {
  id: serial('id').primaryKey(),
  /** e.g. api_key.added | api_key.replaced | api_key.removed | connection.tested
   *  | env_migration.completed | master_key.status_changed | ai_mode.changed */
  eventType: text('event_type').notNull(),
  /** provider name or null (never a secret). */
  provider: text('provider'),
  /** origin of the action, e.g. 'dashboard' | 'startup' | 'cli'. */
  source: text('source'),
  success: boolean('success').notNull(),
  /** scrubbed, human-readable message — NEVER a key/secret or fragment. */
  sanitizedMessage: text('sanitized_message'),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
});
