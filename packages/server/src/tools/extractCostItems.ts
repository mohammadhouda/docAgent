import { pool } from '../db/client.js';
import { SourceReference, ToolResult } from '../types/index.js';

interface CostRow {
  label:       string;
  raw_value:   string;
  numeric_value: number | null;
  unit:        string | null;
  context:     string;
  sheet_name:  string | null;
  page_number: number | null;
  row_number:  number | null;
  file_name:   string;
}

export async function extractCostItems(args: {
  minAmount?: number;
  maxAmount?: number;
  category?:  string;
  currency?:  string;
  documentId?: string;
}): Promise<ToolResult> {
  const { minAmount = 0, maxAmount, category, documentId } = args;
  const likeFilter = category ? `%${category}%` : null;

  const result = await pool.query<CostRow>(
    `SELECT
       ev.label, ev.raw_value, ev.numeric_value, ev.unit,
       ev.context, ev.sheet_name, ev.page_number, ev.row_number,
       d.file_name
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type = 'cost'
       AND ($1::uuid IS NULL OR ev.document_id = $1::uuid)
       AND (ev.numeric_value IS NULL OR ev.numeric_value >= $2)
       AND ($3::float IS NULL OR ev.numeric_value <= $3)
       AND ($4::text IS NULL
            OR COALESCE(ev.sheet_name, '') ILIKE $4
            OR ev.label ILIKE $4)
     ORDER BY ev.numeric_value DESC NULLS LAST
     LIMIT 200`,
    [documentId ?? null, minAmount, maxAmount ?? null, likeFilter],
  );

  if (result.rows.length === 0) {
    return { success: false, data: 'No cost items found.', sources: [] };
  }

  const sources: SourceReference[] = result.rows.map((r) => ({
    documentName: r.file_name,
    location:     r.sheet_name ? `Sheet: ${r.sheet_name}, Row ${r.row_number}` : `Page ${r.page_number}`,
    excerpt:      r.context.slice(0, 150),
  }));

  const items = result.rows.map((r) => ({
    label:    r.label,
    amount:   r.numeric_value,
    currency: r.unit ?? 'SAR',
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
