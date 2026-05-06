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

interface SectionDistRow {
  name:     string;
  min_dist: number;
}

/**
 * Resolves a user-supplied category term into SQL ILIKE patterns used by all tools.
 *
 * Sources of patterns (in priority order):
 *   1. Substring:  `%{category}%` — always included.
 *   2. Code-prefix: `MEP-%`, `MEP.%` — for short all-letter terms that look like BOQ codes.
 *   3. Semantic:   embed the term and find nearby sheet names AND section titles via
 *                  pgvector cosine distance on chunk embeddings; add those as patterns.
 *
 * Searching section_title as well as sheet_name means single-sheet BOQs (where all items
 * share one sheet name) are still correctly filtered by trade section.
 *
 * Returns null when category is undefined, which signals "no filter" to callers.
 */
export async function resolveCategory(
  category: string | undefined,
  documentId?: string,
): Promise<string[] | null> {
  if (!category) return null;

  const patterns = new Set<string>();
  patterns.add(`%${category}%`);

  // Code-prefix expansion for short uppercase-style codes (MEP, ELC, HVAC …)
  const trimmed = category.trim();
  if (/^[A-Za-z]{1,6}$/.test(trimmed)) {
    patterns.add(`${trimmed.toUpperCase()}-%`);
    patterns.add(`${trimmed.toUpperCase()}.%`);
    patterns.add(`${trimmed.toLowerCase()}-%`);
    patterns.add(`${trimmed.toLowerCase()}.%`);
  }

  try {
    const embedding = await generateEmbedding(category);
    const vectorStr = `[${embedding.join(',')}]`;

    // Find nearest sheet names via chunk embeddings
    const sheetResult = await pool.query<SectionDistRow>(
      `SELECT   c.sheet_name   AS name,
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
    for (const row of sheetResult.rows) {
      if (row.min_dist < CATEGORY_SIMILARITY_THRESHOLD) {
        patterns.add(`%${row.name}%`);
      }
    }

    // Find nearest section titles via chunk embeddings (critical for single-sheet BOQs)
    const sectionResult = await pool.query<SectionDistRow>(
      `SELECT   c.section_title AS name,
                MIN(c.embedding <=> $2::vector) AS min_dist
       FROM     chunks c
       WHERE    ($1::uuid IS NULL OR c.document_id = $1::uuid)
         AND    c.section_title IS NOT NULL
         AND    c.embedding     IS NOT NULL
       GROUP BY c.section_title
       ORDER BY min_dist
       LIMIT    8`,
      [documentId ?? null, vectorStr],
    );
    for (const row of sectionResult.rows) {
      if (row.min_dist < CATEGORY_SIMILARITY_THRESHOLD) {
        patterns.add(`%${row.name}%`);
      }
    }
  } catch {
    // Embeddings unavailable — substring and code-prefix patterns still apply.
  }

  return Array.from(patterns);
}

/**
 * Builds the SQL fragment that tests patterns against label, sheet_name, AND section_title.
 * Use this in every tool that accepts a category filter so section-level matching is consistent.
 *
 * Usage in a parameterised query:
 *   WHERE ... AND categoryMatch(patterns, $N)
 *
 * Returns an inline SQL expression (no trailing AND/OR) — callers wrap it:
 *   AND ($N::text[] IS NULL OR <fragment>)
 */
export function categoryMatchSQL(
  patternsParam: string, // e.g. '$3'
  evAlias = 'ev',
): string {
  return (
    `COALESCE(${evAlias}.sheet_name, '')   ILIKE ANY(${patternsParam}::text[]) OR ` +
    `COALESCE(${evAlias}.section_title, '') ILIKE ANY(${patternsParam}::text[]) OR ` +
    `${evAlias}.label                       ILIKE ANY(${patternsParam}::text[])`
  );
}
