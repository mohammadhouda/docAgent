import { pool } from '../db/client.js';
import { SourceReference, ToolResult } from '../types/index.js';

interface SummaryRow {
  group_key:   string | null;
  file_name:   string;
  total:       number;
  item_count:  number;
  currency:    string | null;
}

export async function calculateCostSummary(args: {
  documentId?: string;
  category?:   string;
}): Promise<ToolResult> {
  const { documentId, category } = args;
  const likeFilter = category ? `%${category}%` : null;

  // Group by sheet_name (section/trade for Excel) or document when sheet is null (PDF).
  // category filter matches sheet name OR item label — handles both sheet-per-trade layouts
  // and single-sheet BOQs where the trade appears in item descriptions.
  const result = await pool.query<SummaryRow>(
    `SELECT
       COALESCE(ev.sheet_name, d.file_name) AS group_key,
       d.file_name,
       SUM(ev.numeric_value)::float          AS total,
       COUNT(*)::int                         AS item_count,
       MAX(ev.unit)                          AS currency
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type = 'cost'
       AND ev.numeric_value IS NOT NULL
       AND ($1::uuid IS NULL OR ev.document_id = $1::uuid)
       AND ($2::text IS NULL
            OR COALESCE(ev.sheet_name, d.file_name) ILIKE $2
            OR ev.label ILIKE $2)
     GROUP BY COALESCE(ev.sheet_name, d.file_name), d.file_name
     ORDER BY total DESC`,
    [documentId ?? null, likeFilter],
  );

  if (result.rows.length === 0) {
    return { success: false, data: 'No cost data found to summarise.', sources: [] };
  }

  const grandTotal = result.rows.reduce((s, r) => s + r.total, 0);
  const currency   = result.rows[0].currency ?? 'SAR';

  const sources: SourceReference[] = result.rows.map((r) => ({
    documentName: r.file_name,
    location:     r.group_key ?? r.file_name,
    excerpt:      `${r.item_count} items totalling ${r.total.toLocaleString()} ${currency}`,
  }));

  return {
    success: true,
    data: {
      grandTotal,
      currency,
      categoryFilter: category ?? null,
      groups: result.rows.map((r) => ({
        section:    r.group_key,
        document:   r.file_name,
        total:      r.total,
        itemCount:  r.item_count,
        currency,
      })),
    },
    sources,
  };
}
