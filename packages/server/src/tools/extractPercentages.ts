import { pool } from '../db/client.js';
import { ToolResult } from '../types/index.js';
import { buildSources } from './utils.js';

interface PctRow {
  label:         string;
  raw_value:     string;
  numeric_value: number | null;
  context:       string;
  sheet_name:    string | null;
  page_number:   number | null;
  row_number:    number | null;
  file_name:     string;
}

export async function extractPercentages(args: {
  documentId?: string;
}): Promise<ToolResult> {
  const { documentId } = args;

  const result = await pool.query<PctRow>(
    `SELECT
       ev.label, ev.raw_value, ev.numeric_value,
       ev.context, ev.sheet_name, ev.page_number, ev.row_number,
       d.file_name
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type = 'percentage'
       AND ($1::uuid IS NULL OR ev.document_id = $1::uuid)
     ORDER BY ev.numeric_value DESC NULLS LAST
     LIMIT 100`,
    [documentId ?? null],
  );

  if (result.rows.length === 0) {
    return { success: false, data: 'No percentage values found.', sources: [] };
  }

  const items = result.rows.map((r) => ({
    label:   r.label,
    value:   r.numeric_value !== null ? `${r.numeric_value}%` : r.raw_value,
    numeric: r.numeric_value,
    source:  r.file_name,
  }));

  return {
    success: true,
    data:    { items, totalItems: items.length },
    sources: buildSources(result.rows),
  };
}
