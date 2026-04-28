import { pool } from '../db/client.js';
import { ToolResult } from '../types/index.js';
import { buildSources, likeParam } from './utils.js';

interface CompareRow {
  file_name:     string;
  document_id:   string;
  label:         string;
  numeric_value: number | null;
  unit:          string | null;
  sheet_name:    string | null;
  page_number:   number | null;
  row_number:    number | null;
  context:       string;
}

interface DocTotal {
  file_name:   string;
  document_id: string;
  total:       number;
  item_count:  number;
}

// This tool compares costs across multiple BOQ documents, optionally filtered by category (e.g. trade/section).
export async function compareCosts(args: {
  category?:    string;
  documentIds?: string[];
}): Promise<ToolResult> {
  const { category, documentIds } = args;

  const idsFilter  = documentIds && documentIds.length > 0 ? documentIds : null;
  const likeFilter = likeParam(category);

  // Per-item breakdown across documents
  const rows = await pool.query<CompareRow>(
    `SELECT d.file_name, d.id AS document_id,
            ev.label, ev.numeric_value, ev.unit,
            ev.sheet_name, ev.page_number, ev.row_number, ev.context
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type = 'cost'
       AND ev.numeric_value IS NOT NULL
       AND ($1::text IS NULL
            OR COALESCE(ev.sheet_name, d.file_name) ILIKE $1
            OR ev.label ILIKE $1)
       AND ($2::uuid[] IS NULL OR ev.document_id = ANY($2::uuid[]))
     ORDER BY ev.numeric_value DESC
     LIMIT 300`,
    [likeFilter, idsFilter],
  );

  // Grand total per document
  const totals = await pool.query<DocTotal>(
    `SELECT d.file_name, d.id AS document_id,
            SUM(ev.numeric_value)::float AS total,
            COUNT(*)::int                AS item_count
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type = 'cost'
       AND ev.numeric_value IS NOT NULL
       AND ($1::text IS NULL
            OR COALESCE(ev.sheet_name, d.file_name) ILIKE $1
            OR ev.label ILIKE $1)
       AND ($2::uuid[] IS NULL OR ev.document_id = ANY($2::uuid[]))
     GROUP BY d.file_name, d.id
     ORDER BY total DESC`,
    [likeFilter, idsFilter],
  );

  if (rows.rows.length === 0) {
    return { success: false, data: 'No matching cost items found across documents.', sources: [] };
  }

  // Group items by document for a structured comparison
  const byDoc = new Map<string, { fileName: string; items: typeof rows.rows }>();
  for (const r of rows.rows) {
    if (!byDoc.has(r.document_id)) byDoc.set(r.document_id, { fileName: r.file_name, items: [] });
    byDoc.get(r.document_id)!.items.push(r);
  }

  return {
    success: true,
    data: {
      summary: totals.rows.map((t) => ({
        document:  t.file_name,
        totalCost: t.total,
        itemCount: t.item_count,
        currency:  rows.rows.find((r) => r.document_id === t.document_id)?.unit ?? 'SAR',
      })),
      breakdown: Array.from(byDoc.values()).map(({ fileName, items }) => ({
        document: fileName,
        items: items.map((r) => ({
          label:    r.label,
          amount:   r.numeric_value,
          currency: r.unit ?? 'SAR',
          location: r.sheet_name ? `Sheet: ${r.sheet_name}, Row ${r.row_number}` : '',
        })),
      })),
    },
    sources: buildSources(rows.rows),
  };
}
