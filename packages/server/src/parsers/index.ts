import path from 'path';
import { DocumentChunk } from '../types/index.js';
import { parsePdf } from './pdfParser.js';
import { parseExcel } from './excelParser.js';
import { ExtractedValue } from '../extractors/types.js';

export const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.xlsx', '.xls', '.csv']);

export interface ParseResult {
  chunks: DocumentChunk[];
  totalPages?: number;
  totalSheets?: number;
  warnings: string[];
  extractedValues: ExtractedValue[];
}

// Main function to parse a file based on its extension, returning structured chunks and extracted values
export async function parseFile(filePath: string, documentId: string): Promise<ParseResult> {
  const ext = path.extname(filePath).toLowerCase();

  // Route to the appropriate parser based on file type, ensuring we only attempt to parse supported formats
  
  if (ext === '.pdf') {
    const result = await parsePdf(filePath, documentId);
    return {
      chunks:          result.chunks,
      totalPages:      result.totalPages,
      warnings:        result.warnings,
      extractedValues: result.extractedValues,
    };
  }

  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
    const result = await parseExcel(filePath, documentId);
    return {
      chunks:          result.chunks,
      totalSheets:     result.totalSheets,
      warnings:        result.warnings,
      extractedValues: result.extractedValues,
    };
  }

  throw new Error(`Unsupported file type: ${ext}`);
}
