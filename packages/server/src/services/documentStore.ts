import { eq, isNotNull } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { chunks, documents, extractedValues, ChunkRow, DocumentRow } from '../db/schema.js';
import { Document, DocumentChunk, DocumentMetadata } from '../types/index.js';
import { ExtractedValue } from '../extractors/types.js';

// ─── Raw query row types ─────────────────────────────────────────────────────

// Shape returned by the similarity + keyword search JOIN queries
interface SearchRow {
  id:               string;
  file_name:        string;
  file_path:        string;
  file_type:        string;
  total_pages:      number | null;
  total_sheets:     number | null;
  ingested_at:      Date;
  meta_type:        string | null;
  meta_project_name: string | null;
  meta_currency:    string | null;
  meta_parties:     string[] | null;
  meta_summary:     string | null;
  chunk_id:         string;
  content:          string;
  chunk_index:      number;
  page_number:      number | null;
  sheet_name:       string | null;
  row_start:        number | null;
  row_end:          number | null;
  next_content:     string | null;
}

// ─── Row → Domain mappers ────────────────────────────────────────────────────

function toChunk(row: ChunkRow): DocumentChunk {
  return {
    id:         row.id,
    documentId: row.documentId,
    content:    row.content,
    chunkIndex: row.chunkIndex,
    pageNumber: row.pageNumber ?? undefined,
    sheetName:  row.sheetName  ?? undefined,
    rowRange:   row.rowStart != null && row.rowEnd != null
      ? { start: row.rowStart, end: row.rowEnd }
      : undefined,
    embedding:  row.embedding ?? undefined,
  };
}

function toDocument(docRow: DocumentRow, chunkRows: ChunkRow[]): Document {
  const metadata: DocumentMetadata = {
    type:        (docRow.metaType as DocumentMetadata['type']) ?? 'other',
    projectName: docRow.metaProjectName,
    currency:    docRow.metaCurrency,
    parties:     docRow.metaParties ?? [],
    summary:     docRow.metaSummary ?? '',
  };
  return {
    id:          docRow.id,
    fileName:    docRow.fileName,
    filePath:    docRow.filePath,
    fileType:    docRow.fileType as Document['fileType'],
    totalPages:  docRow.totalPages  ?? undefined,
    totalSheets: docRow.totalSheets ?? undefined,
    chunks:      chunkRows.map(toChunk),
    metadata,
    ingestedAt:  docRow.ingestedAt,
  };
}

// Builds a { chunk, document } pair from a flat search JOIN row.
// Uses a sparse array indexed by chunkIndex so callers can access
// document.chunks[chunkIndex + 1] for context continuity.
function buildSearchResult(r: SearchRow): { chunk: DocumentChunk; document: Document } {
  const chunkRow: ChunkRow = {
    id:         r.chunk_id,
    documentId: r.id,
    content:    r.content,
    chunkIndex: r.chunk_index,
    pageNumber: r.page_number,
    sheetName:  r.sheet_name,
    rowStart:   r.row_start,
    rowEnd:     r.row_end,
    embedding:  null, // not needed after search
  };
  const chunk = toChunk(chunkRow);

  const sparseChunks: DocumentChunk[] = [];
  sparseChunks[chunk.chunkIndex] = chunk;
  if (r.next_content != null) {
    sparseChunks[chunk.chunkIndex + 1] = {
      id: '', documentId: r.id, content: r.next_content,
      chunkIndex: chunk.chunkIndex + 1,
    };
  }

  const docRow: DocumentRow = {
    id:              r.id,
    fileName:        r.file_name,
    filePath:        r.file_path,
    fileType:        r.file_type,
    totalPages:      r.total_pages,
    totalSheets:     r.total_sheets,
    ingestedAt:      r.ingested_at,
    metaType:        r.meta_type,
    metaProjectName: r.meta_project_name,
    metaCurrency:    r.meta_currency,
    metaParties:     r.meta_parties,
    metaSummary:     r.meta_summary,
  };

  // Pass sparseChunks so the document retains context-window chunks
  return { chunk, document: { ...toDocument(docRow, [chunkRow]), chunks: sparseChunks } };
}

// ─── Store ───────────────────────────────────────────────────────────────────

class DocumentStore {
  // --- Write -----------------------------------------------------------------

  async addDocument(doc: Document): Promise<void> {
    await db.insert(documents).values({
      id:              doc.id,
      fileName:        doc.fileName,
      filePath:        doc.filePath,
      fileType:        doc.fileType,
      totalPages:      doc.totalPages  ?? null,
      totalSheets:     doc.totalSheets ?? null,
      ingestedAt:      doc.ingestedAt,
      metaType:        doc.metadata.type        ?? null,
      metaProjectName: doc.metadata.projectName ?? null,
      metaCurrency:    doc.metadata.currency    ?? null,
      metaParties:     doc.metadata.parties     ?? [],
      metaSummary:     doc.metadata.summary     ?? null,
    });

    // Insert chunks in batches of 100 to stay within pg parameter limits
    const BATCH = 100;
    for (let i = 0; i < doc.chunks.length; i += BATCH) {
      await db.insert(chunks).values(
        doc.chunks.slice(i, i + BATCH).map((c) => ({
          id:         c.id,
          documentId: c.documentId,
          content:    c.content,
          chunkIndex: c.chunkIndex,
          pageNumber: c.pageNumber ?? null,
          sheetName:  c.sheetName  ?? null,
          rowStart:   c.rowRange?.start ?? null,
          rowEnd:     c.rowRange?.end   ?? null,
          embedding:  c.embedding ?? null,
        })),
      );
    }
  }

  async addExtractedValues(values: ExtractedValue[]): Promise<void> {
    if (values.length === 0) return;
    const BATCH = 100;
    for (let i = 0; i < values.length; i += BATCH) {
      await db.insert(extractedValues).values(
        values.slice(i, i + BATCH).map((v) => ({
          id:           v.id,
          documentId:   v.documentId,
          type:         v.type,
          label:        v.label,
          rawValue:     v.rawValue,
          numericValue: v.numericValue ?? null,
          dateValue:    v.dateValue ?? null,
          unit:         v.unit ?? null,
          context:      v.context,
          sheetName:    v.sheetName ?? null,
          pageNumber:   v.pageNumber ?? null,
          rowNumber:    v.rowNumber ?? null,
        })),
      );
    }
  }

  async clear(): Promise<void> {
    // CASCADE in the schema removes chunks and extracted_values automatically
    await db.delete(documents);
  }

  // --- Read (Drizzle query builder) ------------------------------------------

  async getAll(): Promise<Document[]> {
    const rows = await db
      .select()
      .from(documents)
      .leftJoin(chunks, eq(chunks.documentId, documents.id));

    const docMap = new Map<string, { docRow: DocumentRow; chunkRows: ChunkRow[] }>();
    for (const row of rows) {
      if (!docMap.has(row.documents.id)) {
        docMap.set(row.documents.id, { docRow: row.documents, chunkRows: [] });
      }
      if (row.chunks) docMap.get(row.documents.id)!.chunkRows.push(row.chunks);
    }

    return Array.from(docMap.values()).map(({ docRow, chunkRows }) =>
      toDocument(docRow, chunkRows),
    );
  }

  async getById(id: string): Promise<Document | undefined> {
    const rows = await db
      .select()
      .from(documents)
      .leftJoin(chunks, eq(chunks.documentId, documents.id))
      .where(eq(documents.id, id));

    if (rows.length === 0) return undefined;
    const chunkRows = rows.map((r) => r.chunks).filter(Boolean) as ChunkRow[];
    return toDocument(rows[0].documents, chunkRows);
  }

  async findDocument(selector: string): Promise<Document | undefined> {
    return (
      (await this.getById(selector)) ??
      (await this.getAll()).find(
        (d) =>
          d.fileName.toLowerCase() === selector.toLowerCase() ||
          d.fileName.toLowerCase().includes(selector.toLowerCase()),
      )
    );
  }

  async hasEmbeddings(): Promise<boolean> {
    const rows = await db
      .select({ id: chunks.id })
      .from(chunks)
      .where(isNotNull(chunks.embedding))
      .limit(1);
    return rows.length > 0;
  }

  async count(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM documents',
    );
    return parseInt(result.rows[0].count, 10);
  }

  // --- Search (raw pg for vector/FTS operators) ------------------------------

  // Cosine similarity via pgvector's <=> operator.
  async searchBySimilarity(
    queryEmbedding: number[],
    maxResults = 8,
  ): Promise<Array<{ chunk: DocumentChunk; document: Document }>> {
    const result = await pool.query<SearchRow>(
      `SELECT
        d.id, d.file_name, d.file_path, d.file_type, d.total_pages, d.total_sheets,
        d.ingested_at, d.meta_type, d.meta_project_name, d.meta_currency,
        d.meta_parties, d.meta_summary,
        c.id          AS chunk_id,
        c.content,
        c.chunk_index,
        c.page_number,
        c.sheet_name,
        c.row_start,
        c.row_end,
        nc.content    AS next_content
       FROM chunks c
       JOIN documents d ON c.document_id = d.id
       LEFT JOIN chunks nc
         ON nc.document_id = c.document_id
        AND nc.chunk_index  = c.chunk_index + 1
       WHERE c.embedding IS NOT NULL
       ORDER BY c.embedding <=> $1::vector
       LIMIT $2`,
      [`[${queryEmbedding.join(',')}]`, maxResults],
    );
    return result.rows.map(buildSearchResult);
  }

  // Full-text search using PostgreSQL's tsvector ranking.
  async searchByKeyword(
    query: string,
    maxResults = 10,
  ): Promise<Array<{ chunk: DocumentChunk; document: Document }>> {
    const result = await pool.query<SearchRow>(
      `SELECT
        d.id, d.file_name, d.file_path, d.file_type, d.total_pages, d.total_sheets,
        d.ingested_at, d.meta_type, d.meta_project_name, d.meta_currency,
        d.meta_parties, d.meta_summary,
        c.id          AS chunk_id,
        c.content,
        c.chunk_index,
        c.page_number,
        c.sheet_name,
        c.row_start,
        c.row_end,
        nc.content    AS next_content
       FROM chunks c
       JOIN documents d ON c.document_id = d.id
       LEFT JOIN chunks nc
         ON nc.document_id = c.document_id
        AND nc.chunk_index  = c.chunk_index + 1
       WHERE to_tsvector('english', c.content) @@ plainto_tsquery('english', $1)
       ORDER BY ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', $1)) DESC,
                c.chunk_index ASC
       LIMIT $2`,
      [query, maxResults],
    );
    return result.rows.map(buildSearchResult);
  }
}

export const documentStore = new DocumentStore();
