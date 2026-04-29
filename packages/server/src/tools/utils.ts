import { pool } from '../db/client.js';
import { generateEmbedding } from '../services/embeddings.js';
import { SourceReference } from '../types/index.js';

interface LocationRow {
  sheet_name:  string | null;
  row_number:  number | null;
  page_number: number | null;
}

interface SourceRow extends LocationRow {
  file_name: string;
  context:   string;
}

export function formatLocation(row: LocationRow): string {
  if (row.sheet_name) return `Sheet: ${row.sheet_name}, Row ${row.row_number}`;
  if (row.page_number) return `Page ${row.page_number}`;
  return '';
}

export function buildSources(rows: SourceRow[]): SourceReference[] {
  return rows.map((r) => ({
    documentName: r.file_name,
    location:     formatLocation(r),
    excerpt:      r.context.slice(0, 150),
  }));
}

/** Simple LIKE pattern for keyword filters that don't need semantic expansion (role, unit, item). */
export function likeParam(value: string | undefined): string | null {
  return value ? `%${value}%` : null;
}

// Cosine distance threshold: sheets further than this from the query embedding are ignored.
const CATEGORY_SIMILARITY_THRESHOLD = 0.65;

interface SheetDistRow {
  sheet_name: string;
  min_dist:   number;
}

/**
 * Resolves a user-supplied category term (e.g. "ELC", "elec", "electrical") into an array of
 * SQL LIKE patterns for use with `ILIKE ANY($n::text[])`.
 *
 * Strategy:
 *   1. Always include `%{category}%` so partial matches still work.
 *   2. Embed the term and find which document sheets are nearest in vector space — those sheet
 *      names are added as additional patterns, covering abbreviations that are not substrings
 *      of the canonical name (e.g. "ELC" → "Electrical Works").
 *   3. If embeddings are unavailable, only the original ILIKE pattern is returned.
 *
 * Returns null when category is undefined, which signals "no filter" to the SQL query.
 */
export async function resolveCategory(
  category: string | undefined,
  documentId?: string,
): Promise<string[] | null> {
  if (!category) return null;

  const patterns = new Set<string>();
  patterns.add(`%${category}%`);

  try {
    const embedding = await generateEmbedding(category);
    const vectorStr = `[${embedding.join(',')}]`;

    const result = await pool.query<SheetDistRow>(
      `SELECT   c.sheet_name,
                MIN(c.embedding <=> $2::vector) AS min_dist
       FROM     chunks c
       WHERE    ($1::uuid IS NULL OR c.document_id = $1::uuid)
         AND    c.sheet_name IS NOT NULL
         AND    c.embedding  IS NOT NULL
       GROUP BY c.sheet_name
       ORDER BY min_dist
       LIMIT    5`,
      [documentId ?? null, vectorStr],
    );

    for (const row of result.rows) {
      if (row.min_dist < CATEGORY_SIMILARITY_THRESHOLD) {
        patterns.add(`%${row.sheet_name}%`);
      }
    }
  } catch {
    // Embeddings unavailable — the original ILIKE pattern is still in the set.
  }

  return Array.from(patterns);
}
