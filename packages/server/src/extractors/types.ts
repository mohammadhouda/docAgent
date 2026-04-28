export type ValueType =
  | 'cost'
  | 'date'
  | 'percentage'
  | 'duration'
  | 'quantity'
  | 'party'
  | 'reference';

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
