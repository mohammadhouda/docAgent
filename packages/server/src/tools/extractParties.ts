import { pool } from '../db/client.js';
import { ToolResult } from '../types/index.js';
import { buildSources, likeParam } from './utils.js';

interface PartyRow {
  label:      string;
  raw_value:  string;
  context:    string;
  sheet_name: string | null;
  page_number: number | null;
  row_number: number | null;
  file_name:  string;
}

// This tool extracts parties (e.g. client, contractor, subcontractor) from BOQ documents, optionally filtered by role keyword and/or document ID.
// The output includes the list of parties with their roles, sources, and context for citation. 
// For example, it can be used to identify the main contractor and subcontractors involved in a project by looking for common role labels in the BOQ document.
export async function extractParties(args: {
  documentId?: string;
  role?:       string;
}): Promise<ToolResult> {
  const { documentId, role } = args;

  const result = await pool.query<PartyRow>(
    `SELECT
       ev.label, ev.raw_value,
       ev.context, ev.sheet_name, ev.page_number, ev.row_number,
       d.file_name
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type = 'party'
       AND ($1::uuid IS NULL OR ev.document_id = $1::uuid)
       AND ($2::text IS NULL OR ev.label ILIKE $2 OR ev.raw_value ILIKE $2)
     ORDER BY d.file_name, ev.row_number ASC NULLS LAST
     LIMIT 100`,
    [documentId ?? null, likeParam(role)],
  );

  if (result.rows.length === 0) {
    return { success: false, data: 'No parties found.', sources: [] };
  }

  // Deduplicate by (role, name) so repeated rows don't clutter the result
  const seen = new Set<string>();
  const items = result.rows
    .map((r) => ({ role: r.label, name: r.raw_value, source: r.file_name }))
    .filter((item) => {
      const key = `${item.role}|${item.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return {
    success: true,
    data:    { items, totalItems: items.length },
    sources: buildSources(result.rows),
  };
}
