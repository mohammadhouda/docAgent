import { pool } from '../db/client.js';
import { SourceReference, ToolResult } from '../types/index.js';

interface DocTotalRow {
  document_id: string;
  file_name:   string;
  total:       number;
  item_count:  number;
  currency:    string | null;
}

export async function calculateCostVariance(args: {
  documentIdA: string;
  documentIdB: string;
  category?:   string;
}): Promise<ToolResult> {
  const { documentIdA, documentIdB, category } = args;
  const likeFilter = category ? `%${category}%` : null;

  const result = await pool.query<DocTotalRow>(
    `SELECT
       d.id   AS document_id,
       d.file_name,
       SUM(ev.numeric_value)::float AS total,
       COUNT(*)::int                AS item_count,
       MAX(ev.unit)                 AS currency
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type = 'cost'
       AND ev.numeric_value IS NOT NULL
       AND ev.document_id = ANY($1::uuid[])
       AND ($2::text IS NULL
            OR COALESCE(ev.sheet_name, d.file_name) ILIKE $2
            OR ev.label ILIKE $2)
     GROUP BY d.id, d.file_name
     ORDER BY total DESC`,
    [[documentIdA, documentIdB], likeFilter],
  );

  if (result.rows.length < 2) {
    return {
      success: false,
      data:    'Could not retrieve cost totals for both documents. Check that both document IDs are correct and contain cost data.',
      sources: [],
    };
  }

  const docA = result.rows.find((r) => r.document_id === documentIdA) ?? result.rows[0];
  const docB = result.rows.find((r) => r.document_id === documentIdB) ?? result.rows[1];

  const absoluteDiff  = docA.total - docB.total;
  const percentageDiff = docB.total !== 0
    ? Math.round((absoluteDiff / docB.total) * 10000) / 100
    : null;

  const currency = docA.currency ?? docB.currency ?? 'SAR';

  const sources: SourceReference[] = result.rows.map((r) => ({
    documentName: r.file_name,
    location:     category ? `Category: ${category}` : 'All sections',
    excerpt:      `Total: ${r.total.toLocaleString()} ${currency} across ${r.item_count} items`,
  }));

  return {
    success: true,
    data: {
      category:      category ?? null,
      currency,
      documentA: {
        id:        docA.document_id,
        fileName:  docA.file_name,
        total:     docA.total,
        itemCount: docA.item_count,
      },
      documentB: {
        id:        docB.document_id,
        fileName:  docB.file_name,
        total:     docB.total,
        itemCount: docB.item_count,
      },
      variance: {
        absoluteDiff,                      // positive = A is more expensive
        percentageDiff,                    // positive = A costs X% more than B
        higherCost:  docA.total > docB.total ? docA.file_name : docB.file_name,
        lowerCost:   docA.total < docB.total ? docA.file_name : docB.file_name,
      },
    },
    sources,
  };
}
