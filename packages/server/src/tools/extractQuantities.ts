import { pool } from '../db/client.js';
import { ToolResult } from '../types/index.js';
import { buildSources, formatLocation, likeParam } from './utils.js';

interface QuantityRow {
  label:         string;
  raw_value:     string;
  numeric_value: number | null;
  unit:          string | null;
  context:       string;
  sheet_name:    string | null;
  page_number:   number | null;
  row_number:    number | null;
  file_name:     string;
}

// This tool extracts quantity values from BOQ documents, which can represent material quantities, lengths, areas, or other measurable information.
export async function extractQuantities(args: {
  documentId?: string;
  unit?:       string;
  minValue?:   number;
}): Promise<ToolResult> {
  const { documentId, unit, minValue = 0 } = args;

  const result = await pool.query<QuantityRow>(
    `SELECT
       ev.label, ev.raw_value, ev.numeric_value, ev.unit,
       ev.context, ev.sheet_name, ev.page_number, ev.row_number,
       d.file_name
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type = 'quantity'
       AND ($1::uuid IS NULL OR ev.document_id = $1::uuid)
       AND ($2::text IS NULL OR ev.unit ILIKE $2)
       AND (ev.numeric_value IS NULL OR ev.numeric_value >= $3)
     ORDER BY ev.numeric_value DESC NULLS LAST
     LIMIT 200`,
    [documentId ?? null, likeParam(unit), minValue],
  );

  if (result.rows.length === 0) {
    return { success: false, data: 'No quantity items found.', sources: [] };
  }

  const items = result.rows.map((r) => ({
    label:    r.label,
    quantity: r.numeric_value,
    unit:     r.unit,
    source:   r.file_name,
    location: formatLocation(r),
  }));

  return {
    success: true,
    data:    { items, totalItems: items.length },
    sources: buildSources(result.rows),
  };
}
