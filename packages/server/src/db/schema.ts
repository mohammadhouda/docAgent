import { pgTable, text, uuid, integer, timestamp, customType, jsonb, doublePrecision, date } from 'drizzle-orm/pg-core';

// This module defines the database schema for the application using Drizzle ORM. It includes tables for documents, chunks of text extracted from those documents, conversations between users and the assistant, messages within those conversations, and extracted values such as costs and dates. The schema also defines the types for rows in each table, which are used throughout the application to ensure type safety when interacting with the database.
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
  id:           text('id').primaryKey(),
  documentId:   uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  content:      text('content').notNull(),
  chunkIndex:   integer('chunk_index').notNull(),
  pageNumber:   integer('page_number'),
  sheetName:    text('sheet_name'),
  rowStart:     integer('row_start'),
  rowEnd:       integer('row_end'),
  chunkType:    text('chunk_type'),
  sectionTitle: text('section_title'),
  embedding:    vector('embedding'),
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
