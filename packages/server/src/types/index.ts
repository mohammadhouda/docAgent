// Consolidated document profile — replaces separate DocumentMetadata + DocumentProfile
// Stored in documents.profile (JSONB column)
export interface DocumentProfile {
  documentType: 'boq' | 'programme' | 'contract' | 'cost-report' | 'risk-register' | 'specification' | 'procurement' | 'schedule' | 'other';
  summary: string;
  language: string;  // ISO 639-1
  currency: string;  // SAR, USD, AED...
  projectName?: string;
  parties?: string[];
  keyCategories: string[];
  availableValueTypes: string[];
  totalCost?: number;
  sheets?: SheetProfile[];
  suggestedTools: string[];
  queryHints: string[];
}

export interface SheetProfile {
  name: string;
  role: 'line-items' | 'summary' | 'schedule' | 'form' | 'other';
  itemCount: number;
  costTotal?: number;
  currency?: string;
  dominantValueTypes: string[];
}

export interface DocumentProfileEntry {
  id: string;
  fileName: string;
  profile: DocumentProfile | null;
}

export type ChunkType = 'text' | 'table' | 'heading';

export interface DocumentChunk {
  id: string;
  documentId: string;
  content: string;
  pageNumber?: number;
  sheetName?: string;
  rowRange?: { start: number; end: number };
  chunkIndex: number;
  chunkType?: ChunkType;
  sectionTitle?: string;
  embedding?: number[];
}

export interface Document {
  id: string;
  fileName: string;
  filePath: string;
  fileType: 'pdf' | 'xlsx' | 'xls' | 'csv';
  totalPages?: number;
  totalSheets?: number;
  chunks: DocumentChunk[];
  profile: DocumentProfile;  // Consolidated profile (replaces metadata)
  ingestedAt: Date;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ParagraphSection {
  type: 'paragraph';
  content: string;
}

export interface KeyFactItem {
  label: string;
  value: string;
  citation?: string;
}

export interface KeyFactsSection {
  type: 'key_facts';
  title: string;
  items: KeyFactItem[];
}

export interface TimelineItem {
  date: string;
  label: string;
  citation?: string;
}

export interface TimelineSection {
  type: 'timeline';
  title: string;
  items: TimelineItem[];
}

export interface TableSection {
  type: 'table';
  title: string;
  headers: string[];
  rows: string[][];
}

export interface ListItem {
  text: string;
  citation?: string;
}

export interface ListSection {
  type: 'list';
  title: string;
  items: ListItem[];
}

export interface PartyItem {
  role: string;
  name: string;
  citation?: string;
}

export interface PartiesSection {
  type: 'parties';
  title: string;
  items: PartyItem[];
}

export type AnswerSection =
  | ParagraphSection
  | KeyFactsSection
  | TimelineSection
  | TableSection
  | ListSection
  | PartiesSection;

export interface StructuredAnswer {
  title: string;
  summary?: string;
  sections: AnswerSection[];
}

export interface AskResponse {
  answer: StructuredAnswer;
  sources: SourceReference[];
  toolsUsed: string[];
}

export interface SourceReference {
  documentName: string;
  location: string;
  excerpt: string;
}

export interface IngestResponse {
  documentsLoaded: number;
  documents: Array<{
    name: string;
    type: string;
    chunks: number;
  }>;
  warnings: string[];
}

export interface ToolResult {
  success: boolean;
  data: unknown;
  sources: SourceReference[];
}

