import { SourceReference } from '../types/index.js';

interface LocationRow {
  sheet_name:  string | null;
  row_number:  number | null;
  page_number: number | null;
}

interface SourceRow extends LocationRow {
  file_name: string;
  context:   string;
}

export function formatLocation(row: LocationRow): string {
  if (row.sheet_name) return `Sheet: ${row.sheet_name}, Row ${row.row_number}`;
  if (row.page_number) return `Page ${row.page_number}`;
  return '';
}

export function buildSources(rows: SourceRow[]): SourceReference[] {
  return rows.map((r) => ({
    documentName: r.file_name,
    location:     formatLocation(r),
    excerpt:      r.context.slice(0, 150),
  }));
}

export function likeParam(value: string | undefined): string | null {
  return value ? `%${value}%` : null;
}
