// Open-ended — the Excel extractor lets the LLM assign any snake_case type string.
// Known values used by structured query tools: 'cost', 'date', 'percentage',
// 'duration', 'quantity', 'party', 'reference'.
// Novel types (e.g. 'risk_level', 'status', 'technical_score') are stored as-is
// and are accessible via search_documents.
export type ValueType = string;

export interface ExtractedValue {
  id: string;
  documentId: string;
  type: ValueType;
  label: string;
  rawValue: string;
  numericValue?: number;
  dateValue?: Date;
  unit?: string;
  context: string;
  sheetName?: string;
  pageNumber?: number;
  rowNumber?: number;
}
