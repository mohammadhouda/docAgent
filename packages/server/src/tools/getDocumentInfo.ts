import { pool } from '../db/client.js';
import { documentStore } from '../services/documentStore.js';
import { SourceReference, ToolResult } from '../types/index.js';

interface SectionRow {
  document_id:   string;
  file_name:     string;
  sheet_name:    string | null;
  section_title: string | null;
  item_count:    number;
  cost_total:    number | null;
}

interface PrefixRow {
  document_id: string;
  file_name:   string;
  code_prefix: string;
  item_count:  number;
}

interface SheetRow {
  document_id: string;
  sheet_names: string[];
}

/**
 * Document metadata and structure tool — replaces list_documents, get_document_sections, summarize_document.
 *
 * modes:
 *   'list'      — list all loaded documents with IDs, types, metadata. Call once at conversation start.
 *   'sections'  — sheet/section breakdown with item counts, cost totals, and code-letter prefixes.
 *                 Call before using category filters to discover the right keyword.
 *   'summarize' — sample beginning, middle, and end of a document for a content overview.
 */
export async function getDocumentInfo(args: {
  mode:        'list' | 'sections' | 'summarize';
  documentId?: string;
}): Promise<ToolResult> {
  const { mode, documentId } = args;

  // ── LIST ──────────────────────────────────────────────────────────────────
  if (mode === 'list') {
    const docs = await documentStore.getAll();
    if (docs.length === 0) {
      return { success: false, data: 'No documents loaded. Upload a PDF or Excel file first.', sources: [] };
    }

    const sheetResult = await pool.query<SheetRow>(
      `SELECT document_id, array_agg(DISTINCT sheet_name ORDER BY sheet_name) AS sheet_names
       FROM chunks WHERE sheet_name IS NOT NULL GROUP BY document_id`,
    );
    const sheetsByDoc = new Map<string, string[]>(
      sheetResult.rows.map((r) => [r.document_id, r.sheet_names]),
    );

    const list = docs.map((doc, i) => {
      const stats = doc.fileType === 'pdf'
        ? `${doc.totalPages ?? '?'} pages`
        : `${doc.totalSheets ?? '?'} sheets`;
      const p = doc.profile;
      const metaParts = [
        p?.documentType ? `Type: ${p.documentType}`                 : '',
        p?.projectName  ? `Project: ${p.projectName}`               : '',
        p?.currency     ? `Currency: ${p.currency}`                 : '',
        p?.parties?.length ? `Parties: ${p.parties.join(', ')}`     : '',
        p?.summary      ? `Summary: ${p.summary}`                   : '',
      ].filter(Boolean).join(' | ');
      const sheets = sheetsByDoc.get(doc.id);
      const sheetsLine = sheets?.length ? `Sheets: ${sheets.join(', ')}` : '';
      return [
        `${i + 1}. **${doc.fileName}**`,
        `   - ID: \`${doc.id}\``,
        `   - Format: ${doc.fileType.toUpperCase()} (${stats}, ${doc.chunks.length} chunks)`,
        metaParts  ? `   - ${metaParts}`  : '',
        sheetsLine ? `   - ${sheetsLine}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n\n');

    return {
      success: true,
      data: `Loaded documents (${docs.length}):\n\n${list}\n\nUse the ID when calling other tools for a specific document.`,
      sources: [],
    };
  }

  // ── SECTIONS ──────────────────────────────────────────────────────────────
  if (mode === 'sections') {
    const sectionResult = await pool.query<SectionRow>(
      `SELECT
         d.id            AS document_id,
         d.file_name,
         ev.sheet_name,
         ev.section_title,
         COUNT(*)::int   AS item_count,
         SUM(CASE WHEN ev.type = 'cost' THEN ev.numeric_value ELSE NULL END)::float AS cost_total
       FROM extracted_values ev
       JOIN documents d ON ev.document_id = d.id
       WHERE ($1::uuid IS NULL OR ev.document_id = $1::uuid)
       GROUP BY d.id, d.file_name, ev.sheet_name, ev.section_title
       ORDER BY d.file_name, cost_total DESC NULLS LAST`,
      [documentId ?? null],
    );

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
      return { success: false, data: 'No section data found.', sources: [] };
    }

    const byDoc = new Map<string, { fileName: string; sections: SectionRow[]; prefixes: string[] }>();
    for (const r of sectionResult.rows) {
      if (!byDoc.has(r.document_id)) byDoc.set(r.document_id, { fileName: r.file_name, sections: [], prefixes: [] });
      byDoc.get(r.document_id)!.sections.push(r);
    }
    for (const r of prefixResult.rows) {
      if (!byDoc.has(r.document_id)) byDoc.set(r.document_id, { fileName: r.file_name, sections: [], prefixes: [] });
      byDoc.get(r.document_id)!.prefixes.push(`${r.code_prefix} (${r.item_count} items)`);
    }

    const documents = Array.from(byDoc.entries()).map(([docId, entry]) => ({
      documentId: docId,
      fileName:   entry.fileName,
      sections: entry.sections.map((s) => ({
        sheet:        s.sheet_name,
        section:      s.section_title,
        itemCount:    s.item_count,
        costTotal:    s.cost_total,
      })),
      codePrefixes: entry.prefixes,
    }));

    return { success: true, data: { documents }, sources: [] };
  }

  // ── SUMMARIZE ─────────────────────────────────────────────────────────────
  if (mode === 'summarize') {
    if (!documentId) {
      return { success: false, data: 'summarize mode requires documentId.', sources: [] };
    }
    const doc = await documentStore.findDocument(documentId);
    if (!doc) {
      return { success: false, data: `Document "${documentId}" not found.`, sources: [] };
    }
    const total = doc.chunks.length;
    let selected = doc.chunks;
    if (total > 6) {
      const mid = Math.floor(total / 2);
      selected = [
        doc.chunks[0], doc.chunks[1],
        doc.chunks[mid], doc.chunks[mid + 1],
        doc.chunks[total - 2], doc.chunks[total - 1],
      ].filter(Boolean);
    }
    const content = selected
      .map((c) => `[${c.pageNumber ? `Page ${c.pageNumber}` : `Chunk ${c.chunkIndex + 1}`}]\n${c.content}`)
      .join('\n\n[...]\n\n');
    const sources: SourceReference[] = selected.map((c) => ({
      documentName: doc.fileName,
      location:     c.pageNumber ? `Page ${c.pageNumber}` : `Chunk ${c.chunkIndex + 1}`,
      excerpt:      c.content.slice(0, 150),
    }));
    return {
      success: true,
      data: `DOCUMENT: ${doc.fileName} (${total} chunks total — beginning, middle, end sampled)\n\n${content}`,
      sources,
    };
  }

  return { success: false, data: `Unknown mode: ${mode}`, sources: [] };
}
