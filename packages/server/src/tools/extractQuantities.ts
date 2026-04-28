import { pool } from '../db/client.js';
import { SourceReference, ToolResult } from '../types/index.js';

interface QuantityRow {
  label:         string;
  raw_value:     string;
  numeric_value: number | null;
  unit:          string | null;
  context:       string;
  sheet_name:    string | null;
  row_number:    number | null;
  file_name:     string;
}

export async function extractQuantities(args: {
  documentId?: string;
  unit?:       string;
  minValue?:   number;
}): Promise<ToolResult> {
  const { documentId, unit, minValue = 0 } = args;

  const result = await pool.query<QuantityRow>(
    `SELECT
       ev.label, ev.raw_value, ev.numeric_value, ev.unit,
       ev.context, ev.sheet_name, ev.row_number,
       d.file_name
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type = 'quantity'
       AND ($1::uuid IS NULL OR ev.document_id = $1::uuid)
       AND ($2::text IS NULL OR ev.unit ILIKE $2)
       AND (ev.numeric_value IS NULL OR ev.numeric_value >= $3)
     ORDER BY ev.numeric_value DESC NULLS LAST
     LIMIT 200`,
    [documentId ?? null, unit ? `%${unit}%` : null, minValue],
  );

  if (result.rows.length === 0) {
    return { success: false, data: 'No quantity items found.', sources: [] };
  }

  const sources: SourceReference[] = result.rows.map((r) => ({
    documentName: r.file_name,
    location:     r.sheet_name ? `Sheet: ${r.sheet_name}, Row ${r.row_number}` : `Page ${r.row_number}`,
    excerpt:      r.context.slice(0, 150),
  }));

  const items = result.rows.map((r) => ({
    label:    r.label,
    quantity: r.numeric_value,
    unit:     r.unit,
    source:   r.file_name,
    location: r.sheet_name ? `Sheet: ${r.sheet_name}, Row ${r.row_number}` : `Page ${r.row_number}`,
  }));

  return {
    success: true,
    data: { items, totalItems: items.length },
    sources,
  };
}
