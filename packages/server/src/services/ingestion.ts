import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { parseFile } from '../parsers/index.js';
import { documentStore } from './documentStore.js';
import { generateEmbeddings } from './embeddings.js';
import { extractInitialProfile } from './metadata.js';
import { generateDocumentProfile } from './profileGenerator.js';
import { Document, DocumentProfile } from '../types/index.js';

export interface IngestedFileResult {
  name: string;
  type: string;
  chunks: number;
  warnings: string[];
}

// This service handles the ingestion of uploaded documents. It parses the file to extract text chunks, generates embeddings for those chunks, extracts a profile, and stores everything in the document store. The function returns a summary of the ingestion process, including any warnings that were generated during parsing. It is designed to be called by the ingestion worker when processing jobs from the queue.

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

  // Extract initial profile from first chunks (before structured extraction)
  const sampleText = parseResult.chunks.slice(0, 2).map((c) => c.content).join('\n\n');
  const initialProfile = await extractInitialProfile(sampleText, fileName);

  await documentStore.addDocument({
    id: documentId,
    fileName,
    filePath,
    fileType: ext,
    totalPages: parseResult.totalPages,
    totalSheets: parseResult.totalSheets,
    chunks: parseResult.chunks,
    profile: initialProfile as DocumentProfile,  // Will be enriched below
    ingestedAt: new Date(),
  });

  // Store extracted values separately for efficient querying, linking them to the document ID
  await documentStore.addExtractedValues(parseResult.extractedValues);

  // Generate and persist enriched document profile — enables dynamic agent context injection.
  // Runs after extracted values are stored so the profile generator can query them.
  // Non-fatal: document remains fully usable if profile generation fails.
  try {
    const profile = await generateDocumentProfile(documentId, fileName, initialProfile);
    await documentStore.updateProfile(documentId, profile);
  } catch (err) {
    console.error('[profile] Failed to generate profile for', fileName, err instanceof Error ? err.message : err);
  }

  return {
    name: fileName,
    type: ext,
    chunks: parseResult.chunks.length,
    warnings: parseResult.warnings.map((w) => `[${fileName}] ${w}`),
  };
}
