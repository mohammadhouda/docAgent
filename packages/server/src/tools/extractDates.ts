import { pool } from '../db/client.js';
import { SourceReference, ToolResult } from '../types/index.js';

interface DateRow {
  label:       string;
  raw_value:   string;
  date_value:  string | null;
  context:     string;
  sheet_name:  string | null;
  page_number: number | null;
  row_number:  number | null;
  file_name:   string;
}

export async function extractDatesDeliverables(args: { documentId?: string }): Promise<ToolResult> {
  const { documentId } = args;

  const result = await pool.query<DateRow>(
    `SELECT
       ev.label, ev.raw_value, ev.date_value::text,
       ev.context, ev.sheet_name, ev.page_number, ev.row_number,
       d.file_name
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type = 'date'
       AND ($1::uuid IS NULL OR ev.document_id = $1::uuid)
     ORDER BY ev.date_value ASC NULLS LAST
     LIMIT 200`,
    [documentId ?? null],
  );

  if (result.rows.length === 0) {
    return { success: false, data: 'No dates or milestones found.', sources: [] };
  }

  const sources: SourceReference[] = result.rows.map((r) => ({
    documentName: r.file_name,
    location:     r.sheet_name ? `Sheet: ${r.sheet_name}, Row ${r.row_number}` : `Page ${r.page_number}`,
    excerpt:      r.context.slice(0, 150),
  }));

  const items = result.rows.map((r) => ({
    label:    r.label,
    date:     r.date_value ?? r.raw_value,
    source:   r.file_name,
    location: r.sheet_name ? `Sheet: ${r.sheet_name}, Row ${r.row_number}` : `Page ${r.page_number}`,
    context:  r.context,
  }));

  return {
    success: true,
    data: { items, totalItems: items.length },
    sources,
  };
}
