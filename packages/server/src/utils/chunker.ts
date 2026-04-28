import { DocumentChunk } from '../types/index.js';
import { config } from '../config.js';

export function chunkText(
  text: string,
  documentId: string,
  options: {
    pageNumber?: number;
    sheetName?: string;
    startRow?: number;
  } = {}
): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  const { chunkSize, chunkOverlap } = config;

  if (!text || text.trim().length === 0) return chunks;

  let offset = 0;
  let chunkIndex = 0;

  while (offset < text.length) {
    let end = offset + chunkSize;

    if (end < text.length) {
      // Try to break at paragraph boundary
      const paragraphBreak = text.lastIndexOf('\n\n', end);
      if (paragraphBreak > offset + chunkSize / 2) {
        end = paragraphBreak;
      } else {
        // Fall back to sentence boundary
        const sentenceBreak = text.lastIndexOf('. ', end);
        if (sentenceBreak > offset + chunkSize / 2) {
          end = sentenceBreak + 1;
        }
      }
    }

    const content = text.slice(offset, end).trim();
    if (content.length > 0) {
      chunks.push({
        id: `${documentId}-chunk-${chunkIndex}`,
        documentId,
        content,
        chunkIndex,
        pageNumber: options.pageNumber,
        sheetName: options.sheetName,
        rowRange: options.startRow !== undefined
          ? { start: options.startRow, end: options.startRow + 50 }
          : undefined,
      });
      chunkIndex++;
    }

    offset = end - chunkOverlap;
    if (offset <= 0 || offset >= text.length) break;
  }

  return chunks;
}
