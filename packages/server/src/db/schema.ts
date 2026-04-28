import { pgTable, text, uuid, integer, timestamp, customType, jsonb, doublePrecision, date } from 'drizzle-orm/pg-core';

// pgvector column — stores 1536-dim embeddings from text-embedding-3-small.
// Serialised as "[x,y,z,...]" string on the wire.
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(1536)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    return value.slice(1, -1).split(',').map(Number);
  },
});

export const documents = pgTable('documents', {
  id:              uuid('id').primaryKey(),
  fileName:        text('file_name').notNull(),
  filePath:        text('file_path').notNull(),
  fileType:        text('file_type').notNull(),
  totalPages:      integer('total_pages'),
  totalSheets:     integer('total_sheets'),
  ingestedAt:      timestamp('ingested_at', { withTimezone: true }).notNull(),
  metaType:        text('meta_type'),
  metaProjectName: text('meta_project_name'),
  metaCurrency:    text('meta_currency'),
  metaParties:     text('meta_parties').array(),
  metaSummary:     text('meta_summary'),
});

export const chunks = pgTable('chunks', {
  id:          text('id').primaryKey(),
  documentId:  uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  content:     text('content').notNull(),
  chunkIndex:  integer('chunk_index').notNull(),
  pageNumber:  integer('page_number'),
  sheetName:   text('sheet_name'),
  rowStart:    integer('row_start'),
  rowEnd:      integer('row_end'),
  embedding:   vector('embedding'),
});

export const conversations = pgTable('conversations', {
  id:        uuid('id').primaryKey(),
  title:     text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const messages = pgTable('messages', {
  id:             uuid('id').primaryKey(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role:           text('role').notNull(),
  content:        text('content'),
  answer:         jsonb('answer'),
  sources:        jsonb('sources'),
  toolsUsed:      text('tools_used').array(),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull(),
});

export const extractedValues = pgTable('extracted_values', {
  id:           uuid('id').primaryKey(),
  documentId:   uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  type:         text('type').notNull(),
  label:        text('label').notNull(),
  rawValue:     text('raw_value').notNull(),
  numericValue: doublePrecision('numeric_value'),
  dateValue:    date('date_value', { mode: 'date' }),
  unit:         text('unit'),
  context:      text('context').notNull(),
  sheetName:    text('sheet_name'),
  pageNumber:   integer('page_number'),
  rowNumber:    integer('row_number'),
});

export type DocumentRow         = typeof documents.$inferSelect;
export type ChunkRow            = typeof chunks.$inferSelect;
export type ConversationRow     = typeof conversations.$inferSelect;
export type MessageRow          = typeof messages.$inferSelect;
export type ExtractedValueRow   = typeof extractedValues.$inferSelect;
