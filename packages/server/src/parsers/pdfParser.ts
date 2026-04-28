import pdfParse from 'pdf-parse';
import fs from 'fs';
import { DocumentChunk } from '../types/index.js';
import { chunkText } from '../utils/chunker.js';
import { config } from '../config.js';
import { extractFromPageTexts } from '../extractors/pdfExtractor.js';
import { ExtractedValue } from '../extractors/types.js';

export interface PdfParseResult {
  chunks: DocumentChunk[];
  totalPages: number;
  warnings: string[];
  extractedValues: ExtractedValue[];
}

// Parses a PDF file, extracting text by page, chunking it, and running AI extraction on each page's text.
export async function parsePdf(filePath: string, documentId: string): Promise<PdfParseResult> {
  const warnings: string[] = [];
  const buffer = fs.readFileSync(filePath);

  // Collect per-page text via the pagerender callback.
  // Capture the result to read numpages — avoids a second parse call.
  const pageTexts: string[] = [];

  // pdf-parse's pagerender allows us to capture text page by page, which is crucial for accurate page-level chunking and extraction.
  const parseResult = await pdfParse(buffer, {
    max: config.maxPdfPages,
    pagerender: async (pageData: any) => {
      const textContent = await pageData.getTextContent();
      const text = textContent.items
        .map((item: any) => (typeof item.str === 'string' ? item.str : ''))
        .join(' ');
      pageTexts.push(text.trim());
      return text;
    },
  });

  const totalPages = parseResult.numpages;

  if (totalPages > config.maxPdfPages) {
    warnings.push(
      `PDF has ${totalPages} pages; only first ${config.maxPdfPages} pages processed.`,
    );
  }

  if (pageTexts.length === 0) {
    warnings.push('PDF appears to be empty or has no extractable text (possibly image-based).');
    return { chunks: [], totalPages, warnings, extractedValues: [] };
  }

  // Chunk each page independently — every chunk gets an accurate page number
  const chunks: DocumentChunk[] = [];
  for (let i = 0; i < pageTexts.length; i++) {
    const text = pageTexts[i];
    if (!text || text.trim().length === 0) continue;
    const pageChunks = chunkText(text, documentId, { pageNumber: i + 1 });
    chunks.push(...pageChunks);
  }

  // Re-index chunkIndex and id globally — chunkText resets the counter per
  // page call, so IDs would collide across pages without this correction.
  chunks.forEach((c, idx) => { c.chunkIndex = idx; c.id = `${documentId}-chunk-${idx}`; });

  // AI extraction per page — pageTexts already in memory, no extra file read
  const extractedValues = await extractFromPageTexts(pageTexts, documentId);

  return { chunks, totalPages, warnings, extractedValues };
}
