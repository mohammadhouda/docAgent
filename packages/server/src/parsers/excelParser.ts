import ExcelJS from 'exceljs';
import { DocumentChunk } from '../types/index.js';
import { chunkText } from '../utils/chunker.js';
import { config } from '../config.js';
import { extractFromWorkbook } from '../extractors/excelExtractor.js';
import { ExtractedValue } from '../extractors/types.js';

// This parser reads Excel files using ExcelJS, extracts text content from each sheet and row, and creates document chunks for indexing. It also collects warnings for empty sheets and handles large sheets by batching rows into manageable chunks. The extracted values are processed separately to ensure deterministic results without additional I/O overhead.
function cellToString(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  // Formula cells: use result, not the formula expression
  if (typeof v === 'object' && 'result' in v) {
    const result = (v as ExcelJS.CellFormulaValue).result;
    return result === null || result === undefined ? '' : String(result);
  }
  // For dates, ExcelJS returns a Date object, so we convert it to ISO string for consistency
  return cell.text || String(v);
}

export interface ExcelParseResult {
  chunks: DocumentChunk[];
  totalSheets: number;
  warnings: string[];
  extractedValues: ExtractedValue[];
}

export async function parseExcel(filePath: string, documentId: string): Promise<ExcelParseResult> {
  const workbook = new ExcelJS.Workbook();
  const warnings: string[] = [];
  const chunks: DocumentChunk[] = [];

  await workbook.xlsx.readFile(filePath);

  const totalSheets = workbook.worksheets.length;

  for (const worksheet of workbook.worksheets) {
    const sheetName = worksheet.name;
    const rowCount = worksheet.rowCount;

    if (rowCount === 0) {
      warnings.push(`Sheet "${sheetName}" is empty, skipped.`);
      continue;
    }

    // Extract headers from first row
    const headerRow = worksheet.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      headers[colNumber - 1] = String(cell.value ?? `Column ${colNumber}`);
    });

    let rowBatch: string[] = [];
    let batchStart = 2;
    let batchCount = 0;

    for (let rowNum = 2; rowNum <= rowCount; rowNum++) {
      const row = worksheet.getRow(rowNum);
      const values: string[] = [];
      let hasData = false;

      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const header = headers[colNumber - 1] ?? `Col${colNumber}`;
        const value = cellToString(cell);
        if (value.trim()) {
          values.push(`${header}: ${value}`);
          hasData = true;
        }
      });

      if (hasData) {
        rowBatch.push(`Row ${rowNum}: ${values.join(' | ')}`);
        batchCount++;
      }

      if (batchCount >= 50 || rowNum === rowCount) {
        if (rowBatch.length > 0) {
          const batchText = `Sheet: ${sheetName}\n${rowBatch.join('\n')}`;
          const batchChunks = chunkText(batchText, documentId, {
            sheetName,
            startRow: batchStart,
          });
          chunks.push(...batchChunks);
          rowBatch = [];
          batchStart = rowNum + 1;
          batchCount = 0;
        }
      }
    }

    if (rowCount > config.maxExcelRows) {
      warnings.push(
        `Sheet "${sheetName}" has ${rowCount} rows; large sheets were chunked in batches of 50.`
      );
    }
  }

  // Assign chunk IDs after all chunks are created to ensure deterministic IDs regardless of processing order
  chunks.forEach((c, idx) => { c.chunkIndex = idx; c.id = `${documentId}-chunk-${idx}`; });

  const extractedValues = extractFromWorkbook(workbook, documentId);

  return { chunks, totalSheets, warnings, extractedValues };
}
