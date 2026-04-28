import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { parseFile } from '../parsers/index.js';
import { documentStore } from './documentStore.js';
import { generateEmbeddings } from './embeddings.js';
import { extractDocumentMetadata } from './metadata.js';
import { Document } from '../types/index.js';

export interface IngestedFileResult {
  name: string;
  type: string;
  chunks: number;
  warnings: string[];
}

/**
 * Ingests a document file by parsing its content, 
 * generating embeddings for text chunks, extracting metadata,
 * and storing everything in the database. 
 * Returns a summary of the ingestion result, 
 * including any warnings encountered during parsing.
 */

export async function ingestFile(
  filePath: string,
  fileName: string,
): Promise<IngestedFileResult> {
  const documentId = uuidv4();
  const ext = path.extname(fileName).toLowerCase().slice(1) as Document['fileType'];

  const parseResult = await parseFile(filePath, documentId);

  // Generate embeddings for all chunks in parallel, but only if there are chunks to process
  if (parseResult.chunks.length > 0) {
    const embeddings = await generateEmbeddings(parseResult.chunks.map((c) => c.content));
    parseResult.chunks.forEach((c, i) => { c.embedding = embeddings[i]; });
  }

  // Extract document-level metadata using the text of the first few chunks
  const sampleText = parseResult.chunks.slice(0, 2).map((c) => c.content).join('\n\n');
  const metadata = await extractDocumentMetadata(sampleText, fileName);

  await documentStore.addDocument({
    id: documentId,
    fileName,
    filePath,
    fileType: ext,
    totalPages: parseResult.totalPages,
    totalSheets: parseResult.totalSheets,
    chunks: parseResult.chunks,
    metadata,
    ingestedAt: new Date(),
  });

  // Store extracted values separately for efficient querying, linking them to the document ID
  await documentStore.addExtractedValues(parseResult.extractedValues);

  return {
    name: fileName,
    type: ext,
    chunks: parseResult.chunks.length,
    warnings: parseResult.warnings.map((w) => `[${fileName}] ${w}`),
  };
}
