import { pool } from '../db/client.js';
import { ToolResult } from '../types/index.js';
import { buildSources, formatLocation, likeParam } from './utils.js';

interface CostRow {
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

// This tool extracts cost items from BOQ documents based on optional filters such as minimum/maximum amount, category (matching sheet name or item label), currency, and document ID.
// The output includes the list of cost items with their amounts, currencies, sources, and context for citation. 
// For example, it can be used to extract all cost items above a certain threshold in a specific section of a BOQ document.
export async function extractCostItems(args: {
  minAmount?:  number;
  maxAmount?:  number;
  category?:   string;
  currency?:   string;
  documentId?: string;
}): Promise<ToolResult> {
  const { minAmount = 0, maxAmount, category, documentId } = args;

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
    [documentId ?? null, minAmount, maxAmount ?? null, likeParam(category)],
  );

  if (result.rows.length === 0) {
    return { success: false, data: 'No cost items found.', sources: [] };
  }

  const items = result.rows.map((r) => ({
    label:    r.label,
    amount:   r.numeric_value,
    currency: r.unit ?? 'SAR',
    source:   r.file_name,
    location: formatLocation(r),
    context:  r.context,
  }));

  return {
    success: true,
    data:    { items, totalItems: items.length },
    sources: buildSources(result.rows),
  };
}
