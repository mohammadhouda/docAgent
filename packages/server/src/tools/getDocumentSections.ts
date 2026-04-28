import { pool } from '../db/client.js';
import { ToolResult } from '../types/index.js';

interface SectionRow {
  document_id:  string;
  file_name:    string;
  sheet_name:   string | null;
  item_count:   number;
  section_total: number | null;
}

interface PrefixRow {
  document_id: string;
  file_name:   string;
  code_prefix: string;
  item_count:  number;
}

export async function getDocumentSections(args: {
  documentId?: string;
}): Promise<ToolResult> {
  const { documentId } = args;

  // Sheet-level breakdown: name + item count + cost total per sheet
  const sectionResult = await pool.query<SectionRow>(
    `SELECT
       d.id            AS document_id,
       d.file_name,
       ev.sheet_name,
       COUNT(*)::int   AS item_count,
       SUM(CASE WHEN ev.type = 'cost' THEN ev.numeric_value ELSE NULL END)::float AS section_total
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ($1::uuid IS NULL OR ev.document_id = $1::uuid)
       AND ev.sheet_name IS NOT NULL
     GROUP BY d.id, d.file_name, ev.sheet_name
     ORDER BY d.file_name, section_total DESC NULLS LAST`,
    [documentId ?? null],
  );

  // Item-code prefix breakdown: extracts the letter prefix from codes like "A-001", "M-001"
  // Useful for single-sheet BOQs where trades are identified by code prefix
  const prefixResult = await pool.query<PrefixRow>(
    `SELECT
       d.id            AS document_id,
       d.file_name,
       UPPER(REGEXP_REPLACE(ev.label, '^([A-Za-z]+)[-.].*', '\\1')) AS code_prefix,
       COUNT(*)::int   AS item_count
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type = 'cost'
       AND ($1::uuid IS NULL OR ev.document_id = $1::uuid)
       AND ev.label ~ '^[A-Za-z]+[-.]'
     GROUP BY d.id, d.file_name, code_prefix
     ORDER BY d.id, item_count DESC`,
    [documentId ?? null],
  );

  if (sectionResult.rows.length === 0 && prefixResult.rows.length === 0) {
    return {
      success: false,
      data: 'No section or code-prefix data found. The document may have no sheet names or item codes.',
      sources: [],
    };
  }

  // Group sheets by document
  const sheetsByDoc = new Map<string, { fileName: string; sheets: typeof sectionResult.rows }>();
  for (const r of sectionResult.rows) {
    if (!sheetsByDoc.has(r.document_id)) {
      sheetsByDoc.set(r.document_id, { fileName: r.file_name, sheets: [] });
    }
    sheetsByDoc.get(r.document_id)!.sheets.push(r);
  }

  // Group prefixes by document
  const prefixesByDoc = new Map<string, string[]>();
  for (const r of prefixResult.rows) {
    if (!prefixesByDoc.has(r.document_id)) prefixesByDoc.set(r.document_id, []);
    prefixesByDoc.get(r.document_id)!.push(`${r.code_prefix} (${r.item_count} items)`);
  }

  const allDocIds = new Set([...sheetsByDoc.keys(), ...prefixesByDoc.keys()]);

  const documents = Array.from(allDocIds).map((docId) => {
    const sheetEntry   = sheetsByDoc.get(docId);
    const prefixEntry  = prefixesByDoc.get(docId);
    const fileName = sheetEntry?.fileName
      ?? prefixResult.rows.find((r) => r.document_id === docId)?.file_name
      ?? docId;

    return {
      documentId: docId,
      fileName,
      sheets: sheetEntry?.sheets.map((s) => ({
        name:        s.sheet_name,
        itemCount:   s.item_count,
        costTotal:   s.section_total,
      })) ?? [],
      codePrefixes: prefixEntry ?? [],
    };
  });

  return {
    success: true,
    data: { documents },
    sources: [],
  };
}
