import { pool } from '../db/client.js';
import { ToolResult } from '../types/index.js';
import { categoryMatchSQL, resolveCategory } from './utils.js';

interface AggRow {
  group_key:  string | null;
  file_name:  string;
  result:     number;
  item_count: number;
  currency:   string | null;
}

type GroupBy      = 'sheet' | 'section' | 'document' | 'category' | 'type';
type Aggregation  = 'sum' | 'count' | 'avg' | 'max' | 'min';

/**
 * Generic aggregation over extracted values.
 *
 * Replaces calculate_cost_summary, compare_costs, calculate_cost_variance,
 * calculate_percentage_of_total, and query_budget_variance.
 *
 * groupBy options:
 *   'sheet'    — groups by sheet_name (one row per sheet)
 *   'section'  — groups by section_title (one row per trade/section within a sheet)
 *   'document' — groups by document (for cross-document comparison)
 *   'category' — groups by code-prefix extracted from the label (MEP, CIV, FIN…)
 *   'type'     — groups by value type (useful for budget vs actual breakdown)
 */
export async function aggregateValues(args: {
  documentId?:  string;
  type:         string;
  groupBy:      GroupBy;
  aggregation?: Aggregation;
  category?:    string;
  excludeSummarySheets?: boolean;
}): Promise<ToolResult> {
  const {
    documentId,
    type,
    groupBy,
    aggregation = 'sum',
    category,
    excludeSummarySheets = false,
  } = args;

  const patterns = await resolveCategory(category, documentId);

  // Build GROUP BY expression
  const groupExpr =
    groupBy === 'section'  ? `COALESCE(ev.section_title, ev.sheet_name, d.file_name)` :
    groupBy === 'document' ? `d.file_name` :
    groupBy === 'category' ? `UPPER(REGEXP_REPLACE(ev.label, '^([A-Za-z]+)[-.].*', '\\1'))` :
    groupBy === 'type'     ? `ev.type` :
    /* sheet */               `COALESCE(ev.sheet_name, d.file_name)`;

  // Build aggregate expression
  const aggExpr =
    aggregation === 'count' ? `COUNT(*)::float` :
    aggregation === 'avg'   ? `AVG(ev.numeric_value)::float` :
    aggregation === 'max'   ? `MAX(ev.numeric_value)::float` :
    aggregation === 'min'   ? `MIN(ev.numeric_value)::float` :
    /* sum */                  `SUM(ev.numeric_value)::float`;

  const summaryExclusion = excludeSummarySheets
    ? `AND LOWER(COALESCE(ev.sheet_name, '')) NOT SIMILAR TO '%(summary|rollup|consolidated)%'`
    : '';

  const result = await pool.query<AggRow>(
    `SELECT
       ${groupExpr}      AS group_key,
       d.file_name,
       ${aggExpr}        AS result,
       COUNT(*)::int     AS item_count,
       MAX(ev.unit)      AS currency
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type = $1
       AND ev.numeric_value IS NOT NULL
       AND ($2::uuid IS NULL OR ev.document_id = $2::uuid)
       AND ($3::text[] IS NULL OR (${categoryMatchSQL('$3')}))
       ${summaryExclusion}
     GROUP BY group_key, d.file_name
     ORDER BY result DESC NULLS LAST`,
    [type, documentId ?? null, patterns],
  );

  // Fallback: if category filter returned nothing, re-run without it so agent sees what IS available
  if (result.rows.length === 0 && patterns) {
    const fallback = await pool.query<AggRow>(
      `SELECT
         ${groupExpr}  AS group_key,
         d.file_name,
         ${aggExpr}    AS result,
         COUNT(*)::int AS item_count,
         MAX(ev.unit)  AS currency
       FROM extracted_values ev
       JOIN documents d ON ev.document_id = d.id
       WHERE ev.type = $1
         AND ev.numeric_value IS NOT NULL
         AND ($2::uuid IS NULL OR ev.document_id = $2::uuid)
         ${summaryExclusion}
       GROUP BY group_key, d.file_name
       ORDER BY result DESC NULLS LAST`,
      [type, documentId ?? null],
    );
    if (fallback.rows.length > 0) {
      const currency = fallback.rows[0].currency ?? 'SAR';
      const total    = fallback.rows.reduce((s, r) => s + (r.result ?? 0), 0);
      return {
        success: true,
        data: {
          note:           `Category "${category}" not matched. Showing all available groups:`,
          categoryFilter: category,
          total,
          currency,
          groups: fallback.rows.map((r) => ({
            group:     r.group_key,
            document:  r.file_name,
            result:    r.result,
            itemCount: r.item_count,
            currency:  r.currency ?? currency,
          })),
        },
        sources: [],
      };
    }
    return { success: false, data: `No ${type} data found.`, sources: [] };
  }

  const currency   = result.rows[0]?.currency ?? 'SAR';
  const total      = result.rows.reduce((s, r) => s + (r.result ?? 0), 0);
  const totalItems = result.rows.reduce((s, r) => s + r.item_count, 0);

  // Build interpretation string so the agent knows what the total represents
  const interpretation = category
    ? `Total of ${total.toLocaleString()} ${currency} is the filtered ${aggregation} for "${category}" (${totalItems} items). This IS the ${category} ${type} ${aggregation}.`
    : `Total of ${total.toLocaleString()} ${currency} across all ${result.rows.length} groups (${totalItems} items, no category filter).`;

  return {
    success: true,
    data: {
      total,
      currency,
      aggregation,
      groupBy,
      categoryFilter:    category ?? null,
      isCategoryFiltered: !!category,
      interpretation,
      groups: result.rows.map((r) => ({
        group:     r.group_key,
        document:  r.file_name,
        result:    r.result,
        itemCount: r.item_count,
        currency:  r.currency ?? currency,
      })),
    },
    sources: result.rows.map((r) => ({
      documentName: r.file_name,
      location:     r.group_key ?? r.file_name,
      excerpt:      `${r.item_count} items, ${aggregation}: ${(r.result ?? 0).toLocaleString()} ${r.currency ?? currency}`,
    })),
  };
}
