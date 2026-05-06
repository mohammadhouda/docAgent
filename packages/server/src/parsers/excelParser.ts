import ExcelJS from 'exceljs';
import { DocumentChunk } from '../types/index.js';
import { estimateTokens } from '../utils/chunker.js';
import { config } from '../config.js';
import { extractFromWorkbook } from '../extractors/excelExtractor.js';
import { ExtractedValue } from '../extractors/types.js';

function cellToString(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'result' in v) {
    const result = (v as ExcelJS.CellFormulaValue).result;
    return result === null || result === undefined ? '' : String(result);
  }
  return cell.text || String(v);
}

export interface ExcelParseResult {
  chunks:          DocumentChunk[];
  totalSheets:     number;
  warnings:        string[];
  extractedValues: ExtractedValue[];
}

export async function parseExcel(filePath: string, documentId: string): Promise<ExcelParseResult> {
  const workbook = new ExcelJS.Workbook();
  const warnings: string[] = [];
  const chunks:   DocumentChunk[] = [];

  await workbook.xlsx.readFile(filePath);

  const totalSheets = workbook.worksheets.length;

  for (const worksheet of workbook.worksheets) {
    const sheetName = worksheet.name;
    const rowCount  = worksheet.rowCount;

    if (rowCount === 0) {
      warnings.push(`Sheet "${sheetName}" is empty, skipped.`);
      continue;
    }

    // Column headers from row 1
    const headerRow = worksheet.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      headers[colNumber - 1] = String(cell.value ?? `Col ${colNumber}`);
    });
    const headerLine = `Headers: ${headers.filter(Boolean).join(' | ')}`;

    // ── Section accumulator ─────────────────────────────────────────────────

    let currentSection = '';
    type SectionRow = { text: string; rowNum: number };
    let sectionRows: SectionRow[] = [];

    function flushSection() {
      if (sectionRows.length === 0) return;

      const prefix       = `[Sheet: ${sheetName}${currentSection ? ` | Section: ${currentSection}` : ''}]\n${headerLine}`;
      const prefixTokens = estimateTokens(prefix);

      let batch:       SectionRow[] = [];
      let batchTokens  = prefixTokens;

      function pushChunk() {
        if (batch.length === 0) return;
        const content = `${prefix}\n${batch.map((r) => r.text).join('\n')}`;
        chunks.push({
          id:           '',
          documentId,
          content,
          chunkIndex:   0,
          chunkType:    'table',
          sectionTitle: currentSection || undefined,
          sheetName,
          rowRange: { start: batch[0].rowNum, end: batch[batch.length - 1].rowNum },
        });
      }

      for (const row of sectionRows) {
        const rowTokens = estimateTokens(row.text);
        if (batchTokens + rowTokens > config.targetTokensTable && batch.length > 0) {
          pushChunk();
          // Smart overlap: carry last 2 rows into the next batch
          const overlap    = batch.slice(-2);
          batch            = [...overlap, row];
          batchTokens      = prefixTokens + estimateTokens(batch.map((r) => r.text).join('\n'));
        } else {
          batch.push(row);
          batchTokens += rowTokens;
        }
      }
      pushChunk();

      sectionRows = [];
    }

    // ── Walk data rows ──────────────────────────────────────────────────────

    for (let rowNum = 2; rowNum <= rowCount; rowNum++) {
      const row    = worksheet.getRow(rowNum);
      const cells: string[] = [];
      let numericCount = 0;
      let isBoldRow    = false;

      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const header = headers[colNumber - 1] ?? `Col${colNumber}`;
        const value  = cellToString(cell);
        if (value.trim()) {
          cells.push(`${header}: ${value}`);
          const num = parseFloat(value.replace(/[,\s]/g, ''));
          if (!isNaN(num) && num > 0) numericCount++;
        }
        // Treat the row as bold if the first non-empty cell has bold font
        if (!isBoldRow && cell.font?.bold === true) isBoldRow = true;
      });

      if (cells.length === 0) continue;

      // Section-header detection — a row is a section header when:
      //   (a) bold font and no numeric values, OR
      //   (b) very few cells (≤3) and fewer than 2 numeric values
      // This catches styled BOQ division headers missed by the cell-count heuristic alone.
      const isSectionHeader =
        (isBoldRow && numericCount === 0) ||
        (numericCount < 2 && cells.length <= 3);

      if (isSectionHeader) {
        flushSection();

        // Derive a readable section title from the cell values
        const rawTitle = cells
          .map((c) => c.split(': ').slice(1).join(': '))
          .join(' — ')
          .trim();
        currentSection = rawTitle;

        // Emit a dedicated heading chunk so the section is directly searchable
        if (currentSection) {
          chunks.push({
            id:           '',
            documentId,
            content:      `[Sheet: ${sheetName}]\nSection: ${currentSection}`,
            chunkIndex:   0,
            chunkType:    'heading',
            sectionTitle: currentSection,
            sheetName,
            rowRange:     { start: rowNum, end: rowNum },
          });
        }
        continue;
      }

      sectionRows.push({ text: `Row ${rowNum}: ${cells.join(' | ')}`, rowNum });
    }

    flushSection();

    if (rowCount > config.maxExcelRows) {
      warnings.push(`Sheet "${sheetName}" has ${rowCount} rows; chunked in section-aware token-bounded groups.`);
    }
  }

  // Assign deterministic IDs
  chunks.forEach((c, idx) => { c.chunkIndex = idx; c.id = `${documentId}-chunk-${idx}`; });

  const extractedValues = await extractFromWorkbook(workbook, documentId);

  return { chunks, totalSheets, warnings, extractedValues };
}
