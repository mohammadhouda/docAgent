import { pool } from '../db/client.js';
import { SourceReference, ToolResult } from '../types/index.js';

interface UnitRateRow {
  item:       string;
  cost:       number;
  quantity:   number;
  unit:       string | null;
  unit_rate:  number;
  sheet_name: string | null;
  row_number: number | null;
  file_name:  string;
}

export async function calculateUnitRate(args: {
  item?:       string;
  documentId?: string;
}): Promise<ToolResult> {
  const { item, documentId } = args;
  const likeFilter = item ? `%${item}%` : null;

  // This query looks for rows in the extracted_values table where there is a cost and a quantity on the same row (matching sheet_name and row_number) for the same document. It then calculates the unit rate by dividing cost by quantity. The results are filtered by documentId and item label if provided, and sorted by cost descending.
  const result = await pool.query<UnitRateRow>(
    `SELECT
       c.label                                     AS item,
       c.numeric_value                             AS cost,
       q.numeric_value                             AS quantity,
       q.unit,
       (c.numeric_value / q.numeric_value)::float  AS unit_rate,
       c.sheet_name,
       c.row_number,
       d.file_name
     FROM extracted_values c
     JOIN documents d ON c.document_id = d.id
     JOIN extracted_values q
       ON  q.document_id = c.document_id
       AND q.type        = 'quantity'
       AND q.numeric_value > 0
       AND q.row_number  = c.row_number
       AND (q.sheet_name = c.sheet_name
            OR (q.sheet_name IS NULL AND c.sheet_name IS NULL))
     WHERE c.type = 'cost'
       AND c.numeric_value IS NOT NULL
       AND ($1::uuid IS NULL OR c.document_id = $1::uuid)
       AND ($2::text IS NULL OR c.label ILIKE $2)
     ORDER BY c.numeric_value DESC
     LIMIT 100`,
    [documentId ?? null, likeFilter],
  );

  if (result.rows.length === 0) {
    return {
      success: false,
      data:    item
        ? `No items matching "${item}" found with both a cost and a quantity on the same row.`
        : 'No rows with both cost and quantity found. Unit rates require both values to be present.',
      sources: [],
    };
  }

  const sources: SourceReference[] = result.rows.map((r) => ({
    documentName: r.file_name,
    location:     r.sheet_name ? `Sheet: ${r.sheet_name}, Row ${r.row_number}` : '',
    excerpt:      `${r.item} — ${r.cost.toLocaleString()} ÷ ${r.quantity} ${r.unit ?? ''} = ${r.unit_rate.toFixed(2)} per ${r.unit ?? 'unit'}`,
  }));

  return {
    success: true,
    data: {
      items: result.rows.map((r) => ({
        item:     r.item,
        cost:     r.cost,
        quantity: r.quantity,
        unit:     r.unit ?? 'unit',
        unitRate: Math.round(r.unit_rate * 100) / 100,
        location: r.sheet_name ? `Sheet: ${r.sheet_name}, Row ${r.row_number}` : '',
        document: r.file_name,
      })),
    },
    sources,
  };
}
