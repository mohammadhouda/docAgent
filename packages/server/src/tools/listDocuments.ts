import { pool } from '../db/client.js';
import { documentStore } from '../services/documentStore.js';
import { ToolResult } from '../types/index.js';

interface SheetRow { document_id: string; sheet_names: string[] }

export async function listDocuments(): Promise<ToolResult> {
  const docs = await documentStore.getAll();

  if (docs.length === 0) {
    return {
      success: false,
      data: 'No documents are currently loaded. Please upload a PDF or Excel file first.',
      sources: [],
    };
  }

  // Fetch distinct sheet names per document so the AI knows what's inside each Excel file
  const sheetResult = await pool.query<SheetRow>(
    `SELECT document_id,
            array_agg(DISTINCT sheet_name ORDER BY sheet_name) AS sheet_names
     FROM chunks
     WHERE sheet_name IS NOT NULL
     GROUP BY document_id`,
  );
  const sheetsByDoc = new Map<string, string[]>(
    sheetResult.rows.map((r) => [r.document_id, r.sheet_names]),
  );

  const list = docs
    .map((doc, i) => {
      const stats =
        doc.fileType === 'pdf'
          ? `${doc.totalPages ?? '?'} pages`
          : `${doc.totalSheets ?? '?'} sheets`;

      const meta = doc.metadata;
      const metaLine = [
        meta.type         ? `Type: ${meta.type}`                    : '',
        meta.projectName  ? `Project: ${meta.projectName}`          : '',
        meta.currency     ? `Currency: ${meta.currency}`            : '',
        meta.parties?.length ? `Parties: ${meta.parties.join(', ')}` : '',
        meta.summary      ? `Summary: ${meta.summary}`              : '',
      ]
        .filter(Boolean)
        .join(' | ');

      const sheetNames = sheetsByDoc.get(doc.id);
      const sheetsLine = sheetNames?.length
        ? `Sheets: ${sheetNames.join(', ')}`
        : '';

      return [
        `${i + 1}. **${doc.fileName}**`,
        `   - ID: \`${doc.id}\``,
        `   - Format: ${doc.fileType.toUpperCase()} (${stats}, ${doc.chunks.length} chunks)`,
        metaLine  ? `   - ${metaLine}`  : '',
        sheetsLine ? `   - ${sheetsLine}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  return {
    success: true,
    data: `Loaded documents (${docs.length}):\n\n${list}\n\nUse the ID when calling other tools for a specific document.`,
    sources: [],
  };
}
