import { boolean, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { shipments } from './schema.js';

export const shipmentContainers = pgTable('shipment_containers', {
  id: serial('id').primaryKey(),
  shipmentRefId: text('shipment_ref_id')
    .notNull()
    .references(() => shipments.refId, { onDelete: 'cascade' }),
  containerNumber: text('container_number'),
  sealNumber: text('seal_number'),
  vesselVoyage: text('vessel_voyage'),
  etd: text('etd'),
  eta: text('eta'),
  actualDeparture: text('actual_departure'),
  actualArrival: text('actual_arrival'),
  lastFreeDay: text('last_free_day'),
  emptyReturnDate: text('empty_return_date'),
  status: text('status').notNull().default('planned'),
  notes: text('notes'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
});

export const shipmentFollowUps = pgTable('shipment_follow_ups', {
  id: serial('id').primaryKey(),
  shipmentRefId: text('shipment_ref_id')
    .notNull()
    .references(() => shipments.refId, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  dueDate: text('due_date'),
  priority: text('priority').notNull().default('normal'),
  completed: boolean('completed').notNull().default(false),
  notes: text('notes'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
});
