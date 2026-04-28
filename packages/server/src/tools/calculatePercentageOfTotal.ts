import { pool } from '../db/client.js';
import { SourceReference, ToolResult } from '../types/index.js';

interface TotalsRow {
  category_total: number;
  grand_total:    number;
  currency:       string | null;
}

interface GroupRow {
  group_key: string | null;
  file_name: string;
  subtotal:  number;
}

// This tool calculates the percentage of total cost for a given category (e.g. a trade or section) within a BOQ document.
// It accepts a category keyword and an optional documentId to filter by a specific document. 
// The output includes the category total, grand total, percentage, and a breakdown of matching groups for citation.
// for example, if the category is "Electrical", it will calculate the total cost of all items in the Electrical section and divide by the grand total cost to get the percentage.
export async function calculatePercentageOfTotal(args: {
  category:   string;
  documentId?: string;
}): Promise<ToolResult> {
  const { category, documentId } = args;
  const likeFilter = `%${category}%`;

  // Category total and grand total in one pass
  const totals = await pool.query<TotalsRow>(
    `SELECT
       SUM(CASE
         WHEN (COALESCE(ev.sheet_name, d.file_name) ILIKE $2 OR ev.label ILIKE $2)
         THEN ev.numeric_value ELSE 0
       END)::float AS category_total,
       SUM(ev.numeric_value)::float AS grand_total,
       MAX(ev.unit) AS currency
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type = 'cost'
       AND ev.numeric_value IS NOT NULL
       AND ($1::uuid IS NULL OR ev.document_id = $1::uuid)`,
    [documentId ?? null, likeFilter],
  );

  const { category_total, grand_total, currency } = totals.rows[0];

  if (!grand_total || grand_total === 0) {
    return { success: false, data: 'No cost data found.', sources: [] };
  }
  if (!category_total || category_total === 0) {
    return { success: false, data: `No cost items found matching category "${category}".`, sources: [] };
  }

  const percentage = (category_total / grand_total) * 100;

  // Breakdown of matching groups for citation
  const groups = await pool.query<GroupRow>(
    `SELECT
       COALESCE(ev.sheet_name, d.file_name) AS group_key,
       d.file_name,
       SUM(ev.numeric_value)::float          AS subtotal
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type = 'cost'
       AND ev.numeric_value IS NOT NULL
       AND ($1::uuid IS NULL OR ev.document_id = $1::uuid)
       AND (COALESCE(ev.sheet_name, d.file_name) ILIKE $2 OR ev.label ILIKE $2)
     GROUP BY COALESCE(ev.sheet_name, d.file_name), d.file_name
     ORDER BY subtotal DESC`,
    [documentId ?? null, likeFilter],
  );

  const sources: SourceReference[] = groups.rows.map((r) => ({
    documentName: r.file_name,
    location:     r.group_key ?? r.file_name,
    excerpt:      `${r.group_key} subtotal: ${r.subtotal.toLocaleString()} ${currency ?? 'SAR'}`,
  }));

  return {
    success: true,
    data: {
      category,
      categoryTotal: category_total,
      grandTotal:    grand_total,
      percentage:    Math.round(percentage * 100) / 100,
      currency:      currency ?? 'SAR',
      matchedGroups: groups.rows.map((r) => ({
        section:  r.group_key,
        document: r.file_name,
        subtotal: r.subtotal,
      })),
    },
    sources,
  };
}
