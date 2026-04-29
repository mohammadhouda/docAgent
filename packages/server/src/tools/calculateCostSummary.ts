import { pool } from '../db/client.js';
import { SourceReference, ToolResult } from '../types/index.js';
import { resolveCategory } from './utils.js';

interface SummaryRow {
  group_key:      string | null;
  sheet_name_raw: string | null;
  file_name:      string;
  total:          number;
  item_count:     number;
  currency:       string | null;
  is_summary_row: boolean;
}

export async function calculateCostSummary(args: {
  documentId?: string;
  category?:   string;
}): Promise<ToolResult> {
  const { documentId, category } = args;
  const patterns = await resolveCategory(category, documentId);

  // Summary/rollup sheets (names containing 'summary', 'rollup', 'consolidated') hold
  // pre-aggregated cross-sheet subtotals. Group them by label so each subtotal is
  // visible individually; group regular sheets by sheet name as before.
  const result = await pool.query<SummaryRow>(
    `SELECT
       CASE WHEN LOWER(COALESCE(ev.sheet_name, '')) ~ 'summary|rollup|consolidated'
            THEN ev.label
            ELSE COALESCE(ev.sheet_name, d.file_name)
       END                                                          AS group_key,
       COALESCE(ev.sheet_name, d.file_name)                        AS sheet_name_raw,
       d.file_name,
       SUM(ev.numeric_value)::float                                AS total,
       COUNT(*)::int                                               AS item_count,
       MAX(ev.unit)                                                AS currency,
       (LOWER(COALESCE(ev.sheet_name, '')) ~ 'summary|rollup|consolidated') AS is_summary_row
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type = 'cost'
       AND ev.numeric_value IS NOT NULL
       AND ($1::uuid IS NULL OR ev.document_id = $1::uuid)
       AND ($2::text[] IS NULL
            OR COALESCE(ev.sheet_name, d.file_name) ILIKE ANY($2::text[])
            OR ev.label ILIKE ANY($2::text[]))
     GROUP BY group_key, sheet_name_raw, d.file_name
     ORDER BY total DESC`,
    [documentId ?? null, patterns],
  );

  if (result.rows.length === 0) {
    return { success: false, data: 'No cost data found to summarise.', sources: [] };
  }

  const currency      = result.rows[0].currency ?? 'SAR';
  const summaryRows   = result.rows.filter((r) => r.is_summary_row);
  const regularRows   = result.rows.filter((r) => !r.is_summary_row);
  
  // If summary sheet exists, use ONLY summary sheet categories (they are aggregates of line items)
  // This prevents double-counting: BOQ_Items line items + Summary sheet totals = same data twice
  const hasSummarySheet = summaryRows.length > 0;
  const groupsToUse = hasSummarySheet ? summaryRows : regularRows;
  const grandTotal    = groupsToUse.reduce((s, r) => s + r.total, 0);

  const sources: SourceReference[] = result.rows.map((r) => ({
    documentName: r.file_name,
    location:     r.sheet_name_raw ?? r.file_name,
    excerpt:      `${r.item_count} items totalling ${r.total.toLocaleString()} ${currency}`,
  }));

  const data: Record<string, unknown> = {
    grandTotal,
    currency,
    categoryFilter: category ?? null,
    groups: groupsToUse.map((r) => ({
      section:   r.group_key,
      document:  r.file_name,
      total:     r.total,
      itemCount: r.item_count,
      currency,
    })),
  };

  return { success: true, data, sources };
}
