import { pool } from '../db/client.js';
import { ToolResult } from '../types/index.js';
import { buildSources, categoryMatchSQL, formatLocation, resolveCategory } from './utils.js';

interface ValueRow {
  label:         string;
  raw_value:     string;
  numeric_value: number | null;
  date_value:    Date   | null;
  unit:          string | null;
  type:          string;
  context:       string;
  sheet_name:    string | null;
  section_title: string | null;
  page_number:   number | null;
  row_number:    number | null;
  file_name:     string;
}

/**
 * Generic structured-value retrieval.
 *
 * Replaces extract_cost_items, extract_quantities, extract_dates_deliverables,
 * extract_parties, extract_percentages, and query_schedule_by_status.
 *
 * The `types` array is open-ended — any value type stored during extraction can be queried:
 *   Standard: cost, quantity, date, percentage, party, reference, duration
 *   Custom:   risk_level, status, technical_score, completion_rate, …
 */
export async function queryValues(args: {
  documentId?: string;
  types:       string[];
  category?:   string;
  minValue?:   number;
  maxValue?:   number;
  unit?:       string;
  rawValueFilter?: string;  // filters on raw_value for any categorical column (High, Medium, In Progress, …)
  limit?:      number;
  orderBy?:    'value_desc' | 'value_asc' | 'date_asc' | 'label';
}): Promise<ToolResult> {
  const {
    documentId,
    types,
    category,
    minValue,
    maxValue,
    unit,
    rawValueFilter,
    limit = 150,
    orderBy = 'value_desc',
  } = args;

  if (!types || types.length === 0) {
    return { success: false, data: 'types array is required and must be non-empty.', sources: [] };
  }

  const patterns = await resolveCategory(category, documentId);

  const orderClause =
    orderBy === 'value_asc'  ? 'ev.numeric_value ASC  NULLS LAST' :
    orderBy === 'date_asc'   ? 'ev.date_value    ASC  NULLS LAST' :
    orderBy === 'label'      ? 'ev.label         ASC'             :
                               'ev.numeric_value DESC NULLS LAST';

  const result = await pool.query<ValueRow>(
    `SELECT
       ev.label, ev.raw_value, ev.numeric_value, ev.date_value,
       ev.unit, ev.type, ev.context,
       ev.sheet_name, ev.section_title, ev.page_number, ev.row_number,
       d.file_name
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type = ANY($1::text[])
       AND ($2::uuid IS NULL OR ev.document_id = $2::uuid)
       AND ($3::float IS NULL OR ev.numeric_value >= $3)
       AND ($4::float IS NULL OR ev.numeric_value <= $4)
       AND ($5::text  IS NULL OR ev.unit ILIKE $5)
       AND ($6::text  IS NULL OR ev.raw_value ILIKE $6)
       AND ($7::text[] IS NULL OR (${categoryMatchSQL('$7')}))
     ORDER BY ${orderClause}
     LIMIT $8`,
    [
      types,
      documentId ?? null,
      minValue   ?? null,
      maxValue   ?? null,
      unit       ? `%${unit}%` : null,
      rawValueFilter ? `%${rawValueFilter}%` : null,
      patterns,
      limit,
    ],
  );

  if (result.rows.length === 0) {
    const typeStr = types.join(', ');
    return {
      success: false,
      data: `No values of type [${typeStr}] found${category ? ` matching category "${category}"` : ''}.`,
      sources: [],
    };
  }

  const items = result.rows.map((r) => ({
    type:     r.type,
    label:    r.label,
    value:    r.numeric_value ?? r.date_value ?? r.raw_value,
    unit:     r.unit,
    section:  r.section_title ?? r.sheet_name,
    source:   r.file_name,
    location: formatLocation(r),
    context:  r.context,
  }));

  return {
    success: true,
    data:    { items, totalItems: items.length, types, categoryFilter: category ?? null },
    sources: buildSources(result.rows),
  };
}
