import ExcelJS from 'exceljs';
import { v4 as uuidv4 } from 'uuid';
import { ExtractedValue } from './types.js';
import { openaiClient } from '../services/openai.js';

// ─── LLM-driven schema inference ─────────────────────────────────────────────

type ColRole = 'label' | 'item_no' | 'value' | 'category' | 'skip';

interface ColSchema {
  colIndex: number; // 1-based position in the header list sent to the LLM
  header:   string;
  role:     ColRole;
  type?:    string; // open-ended snake_case; defined when role === 'value'
  unit?:    string; // e.g. SAR, %, m², months
}

const SCHEMA_PROMPT = `You are analysing a spreadsheet from a construction or engineering project.
Given column headers and sample data rows, classify every column.

For each column return:
  colIndex — the 1-based column number exactly as shown in the input
  header   — exact header text
  role     — one of:
               "label"     the primary description / name of each row item
               "item_no"   sequential item number, code, or reference prefix
               "value"     a column worth extracting structured data from
               "category"  a column that groups items into sections/trades/categories (e.g. "MEP Works", "Concrete", "Structural & Facade")
               "skip"      row counters, blank columns, footnotes, or anything not useful
  type     — required when role is "value"; use a standard type where it fits:
                cost, date, percentage, quantity, party, reference, duration, unit_rate
             
             For COST/monetary columns, you MUST distinguish between different cost types:
                - "budget" or "budgeted_cost" — planned/budgeted amounts, total contract value
                - "actual" or "actual_cost" — amounts already paid/spent to date
                - "committed" or "committed_cost" — funds reserved/committed but not yet spent (e.g. approved but unpaid commitments)
                - "variance" — difference between budget and actual (can be negative)
                - "outstanding" — unpaid balance still owed to vendor/supplier (use for accounts payable, outstanding invoices)
                - "unit_rate" — price per unit
                - "cost" — use ONLY for the primary/total cost column when no other distinction applies
             
             For other types use descriptive snake_case:
                risk_level, status, completion_rate, technical_score, weighted_score …
             
  unit     — optional: SAR, AED, USD, %, m², m³, months, days, …

IMPORTANT: 
  - If a column is named "Category", "Trade", "Section", "Discipline", or "Work Section", it should have role "category".
  - When there are multiple monetary columns (Budget, Actual, Variance), give each a DISTINCT type (budget, actual, variance) — do NOT mark them all as "cost".

Return ONLY a JSON object with a single key "columns" containing the array.`;

async function inferSheetSchema(
  headers: string[],
  sampleRows: string[][],
): Promise<ColSchema[]> {
  const colList = headers
    .map((h, i) => `  Col ${i + 1}: "${h}"`)
    .join('\n');

  const rowList = sampleRows
    .map((row, ri) => `  Row ${ri + 2}: [${row.map((v) => `"${v}"`).join(', ')}]`)
    .join('\n');

  try {
    const res = await openaiClient.chat.completions.create({
      model:       'gpt-5.4-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: SCHEMA_PROMPT },
        { role: 'user',   content: `Headers:\n${colList}\n\nSample data:\n${rowList}` },
      ],
    });

    const raw     = res.choices[0]?.message?.content ?? '{}';
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed  = JSON.parse(cleaned);
    const arr     = Array.isArray(parsed) ? parsed : (parsed.columns ?? []);
    return arr as ColSchema[];
  } catch {
    return [];
  }
}

// ─── Cell value helpers ───────────────────────────────────────────────────────

function resolveFormula(cell: ExcelJS.Cell): ExcelJS.CellValue {
  const v = cell.value;
  if (v && typeof v === 'object' && 'result' in v) {
    return (v as ExcelJS.CellFormulaValue).result ?? null;
  }
  return v;
}

function getCellNumber(cell: ExcelJS.Cell): number | undefined {
  const v = resolveFormula(cell);
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[,\s]/g, ''));
    return isNaN(n) ? undefined : n;
  }
  return undefined;
}

function getCellDate(cell: ExcelJS.Cell): Date | undefined {
  const v = resolveFormula(cell);
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  return undefined;
}

function getCellText(cell: ExcelJS.Cell): string {
  const v = resolveFormula(cell);
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toLocaleDateString('en-GB');
  if (typeof v === 'object' && 'richText' in (v as object)) {
    return ((v as ExcelJS.CellRichTextValue).richText ?? []).map((r) => r.text).join('');
  }
  return String(v);
}

function isPercentFormat(cell: ExcelJS.Cell): boolean {
  return (cell.numFmt ?? '').includes('%');
}

// ─── Sheet-level guard ───────────────────────────────────────────────────────

// Skip summary/roll-up sheets entirely during value extraction.
// Their rows are aggregates of line-item data already present in other sheets;
// ingesting them would cause every aggregation query to double-count.
// Chunks from these sheets are still indexed for text search by the chunker.
const SUMMARY_SHEET_RE = /\b(summary|rollup|roll[- ]up|consolidated|overview|totals?|front[- ]sheet|cover)\b/i;

// ─── Row-level guard ──────────────────────────────────────────────────────────

// Skip rows whose label IS purely an aggregate keyword ("Grand Total", "Subtotal", "VAT").
// Rows like "Total MEP Works" or "Civil Works Total" are section subtotals that carry a
// meaningful category name — they must be kept so tools can return per-trade subtotals.
const TOTAL_ROW_RE = /^\s*(grand[\s-]+total|sub[\s-]*total|total|vat)\s*[:\-]?\s*$/i;

// ─── Main extractor ───────────────────────────────────────────────────────────

export async function extractFromWorkbook(
  workbook: ExcelJS.Workbook,
  documentId: string,
): Promise<ExtractedValue[]> {
  const results: ExtractedValue[] = [];

  for (const ws of workbook.worksheets) {
    if (ws.rowCount === 0) continue;
    const sheetName = ws.name;
    if (SUMMARY_SHEET_RE.test(sheetName)) continue;

    // Find the real header row: first row with ≥ 2 distinct non-empty cell values.
    let headerRowNum = 1;
    for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
      const distinct = new Set<string>();
      ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
        const t = getCellText(cell).trim();
        if (t) distinct.add(t);
      });
      if (distinct.size >= 2) { headerRowNum = r; break; }
    }

    // Collect ordered header columns: {colNum (Excel 1-based), header text}
    const headerCols: Array<{ colNum: number; header: string }> = [];
    ws.getRow(headerRowNum).eachCell({ includeEmpty: false }, (cell, colNum) => {
      const h = getCellText(cell).trim();
      if (h) headerCols.push({ colNum, header: h });
    });

    if (headerCols.length === 0) continue;

    // Collect up to 5 sample data rows, aligned with headerCols order.
    const sampleRows: string[][] = [];
    for (let r = headerRowNum + 1; r <= ws.rowCount && sampleRows.length < 5; r++) {
      const row    = ws.getRow(r);
      const values = headerCols.map(({ colNum }) => getCellText(row.getCell(colNum)).trim());
      if (values.some((v) => v.length > 0)) sampleRows.push(values);
    }

    // Ask the LLM to infer the column schema for this sheet.
    const schema = await inferSheetSchema(
      headerCols.map((h) => h.header),
      sampleRows,
    );

    if (schema.length === 0) continue;

    // Normalize types based on header keywords — LLM often marks all monetary columns as "cost"
    // or confuses similar types. We override based on header keywords for consistency.
    const normalizeType = (header: string, inferredType: string): string => {
      const h = header.toLowerCase();
      // Force specific types based on header keywords, regardless of LLM inference
      if (h.includes('outstanding') || h.includes('balance') || h.includes('payable') || h.includes('amount owed')) {
        return 'outstanding';
      }
      if (h.includes('contract')) return 'contract_value';
      if (h.includes('budget') || h.includes('planned')) return 'budget';
      if (h.includes('actual') || h.includes('spent') || h.includes('paid') || h.includes('to date')) return 'actual';
      if (h.includes('variance') || h.includes('difference')) return 'variance';
      if (h.includes('committed') && !h.includes('outstanding')) return 'committed_cost';
      return inferredType;
    };

    // Map actual Excel colNum → ColSchema using the LLM's 1-based colIndex.
    const schemaByColNum = new Map<number, ColSchema>();
    let labelColNum:    number | null = null;
    let itemNoColNum:   number | null = null;
    let categoryColNum: number | null = null;

    for (const entry of schema) {
      const hc = headerCols[entry.colIndex - 1];
      if (!hc) continue;
      // Apply type normalization
      const normalizedType = normalizeType(hc.header, entry.type ?? '');
      const normalizedEntry = { ...entry, type: normalizedType };
      schemaByColNum.set(hc.colNum, normalizedEntry);
      if (entry.role === 'label'    && labelColNum    === null) labelColNum    = hc.colNum;
      if (entry.role === 'item_no'  && itemNoColNum   === null) itemNoColNum   = hc.colNum;
      if (entry.role === 'category' && categoryColNum === null) categoryColNum = hc.colNum;
    }

    // All columns the LLM marked as extractable values.
    const valueColumns = [...schemaByColNum.entries()].filter(
      ([, s]) => s.role === 'value' && s.type,
    );

    if (valueColumns.length === 0 && labelColNum === null) continue;

    // Sheet-level cost resolution:
    //   - Primary cost column: the one the LLM marked type='cost'
    //   - Fallback: compute qty × unit_rate when no direct cost column exists
    const costEntry     = valueColumns.find(([, s]) => s.type === 'cost')     ?? null;
    const unitRateEntry = valueColumns.find(([, s]) => s.type === 'unit_rate') ?? null;
    const qtyForRate    = !costEntry && unitRateEntry
      ? (valueColumns.find(([, s]) => s.type === 'quantity') ?? null)
      : null;

    const activeCurrency =
      costEntry?.[1].unit?.toUpperCase() ??
      costEntry?.[1].header.match(/\b(SAR|AED|USD|QAR|KWD|OMR|EUR|GBP)\b/i)?.[1]?.toUpperCase() ??
      unitRateEntry?.[1].unit?.toUpperCase() ??
      'SAR';

    // ── Walk data rows ──────────────────────────────────────────────────────
    let currentSection = '';

    for (let rowNum = headerRowNum + 1; rowNum <= ws.rowCount; rowNum++) {
      const row = ws.getRow(rowNum);

      const labelCell   = labelColNum  ? row.getCell(labelColNum)  : null;
      const itemNoCell  = itemNoColNum ? row.getCell(itemNoColNum) : null;
      const categoryCell = categoryColNum ? row.getCell(categoryColNum) : null;

      // Use explicit category column value if available, otherwise fall back to label cell
      const explicitCategory = categoryCell ? getCellText(categoryCell).trim() : '';
      const labelDescription = labelCell ? getCellText(labelCell).trim() : '';
      
      // Description: prefer label cell, but fall back to category if no label column exists
      const description = labelDescription || explicitCategory;
      if (!description || TOTAL_ROW_RE.test(description)) continue;

      // A row with a description but nothing in any value column is a section header.
      // Use type-aware checks: numeric types need a positive number; date types need a
      // valid date; everything else (status, party, reference…) needs non-empty text.
      // This ensures schedule/risk rows (whose value columns are dates and text, not
      // numbers) are not silently classified as section headers and discarded.
      const NUMERIC_TYPES = new Set(['cost', 'quantity', 'percentage', 'unit_rate', 'duration']);
      const hasDataValue = valueColumns.some(([colNum, s]) => {
        const cell = row.getCell(colNum);
        if (NUMERIC_TYPES.has(s.type!)) {
          const n = getCellNumber(cell);
          return n !== undefined && n !== 0;
        }
        if (s.type === 'date') return !!getCellDate(cell);
        return getCellText(cell).trim().length > 0;
      });
      if (!hasDataValue && valueColumns.length > 0) {
        currentSection = description;
        continue;
      }

      const itemNo   = itemNoCell ? getCellText(itemNoCell).trim() : '';
      const rowLabel = itemNo ? `${itemNo}: ${description}` : description;

      // Compact context string from all non-empty cells, prefixed with sheet+section
      const parts: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell, colNum) => {
        const val = getCellText(cell).trim();
        if (val) {
          const s = schemaByColNum.get(colNum);
          parts.push(`${s?.header ?? `C${colNum}`}: ${val}`);
        }
      });
      if (parts.length === 0) continue;
      
      // Determine sectionTitle: explicit category column takes priority, then fallback to detected section
      const rowSectionTitle = explicitCategory || currentSection || undefined;
      
      const sectionLabel = currentSection ? ` > ${currentSection}` : '';
      const context = `[${sheetName}${sectionLabel}] ${parts.join(' | ')}`.slice(0, 400);

      // Extract each value column using the LLM-assigned type.
      for (const [colNum, colSchema] of valueColumns) {
        const cell = row.getCell(colNum);
        const type = colSchema.type!;

        // Handle all monetary types: cost, budget, actual, variance, outstanding, contract_value
        if (type === 'cost' || type === 'budget' || type === 'actual' || type === 'variance' ||
            type === 'budgeted_cost' || type === 'actual_cost' || type === 'committed_cost' || type === 'variance_cost' ||
            type === 'outstanding' || type === 'contract_value') {
          const num = getCellNumber(cell);
          // For variance and outstanding, allow negative values; for others, only positive
          const isValid = type === 'variance' || type === 'variance_cost' || type === 'outstanding'
            ? num !== undefined && num !== 0
            : num && num > 0;
          if (isValid) {
            results.push({
              id: uuidv4(), documentId, type,
              label:        rowLabel,
              rawValue:     getCellText(cell) || String(num),
              numericValue: num,
              unit:         colSchema.unit?.toUpperCase() ?? activeCurrency,
              context, sheetName, sectionTitle: rowSectionTitle, rowNumber: rowNum,
            });
          }

        } else if (type === 'date') {
          const d = getCellDate(cell);
          if (d) {
            results.push({
              id: uuidv4(), documentId, type: 'date',
              label:    `${colSchema.header}: ${rowLabel}`,
              rawValue: d.toLocaleDateString('en-GB'),
              dateValue: d,
              context, sheetName, sectionTitle: rowSectionTitle, rowNumber: rowNum,
            });
          }

        } else if (type === 'percentage') {
          const num = getCellNumber(cell);
          if (num !== undefined) {
            const pct = isPercentFormat(cell) ? num * 100 : num;
            // Allow negative percentages for variance columns; otherwise expect 0-100 range
            const isVarianceCol = colSchema.header.toLowerCase().includes('variance');
            const isValid = isVarianceCol
              ? pct >= -100 && pct <= 100
              : pct > 0 && pct <= 100;
            if (isValid) {
              results.push({
                id: uuidv4(), documentId, type: 'percentage',
                label:        `${colSchema.header}: ${rowLabel}`,
                rawValue:     getCellText(cell) || `${pct}%`,
                numericValue: pct,
                unit:         '%',
                context, sheetName, sectionTitle: rowSectionTitle, rowNumber: rowNum,
              });
            }
          }

        } else if (type === 'quantity') {
          const num = getCellNumber(cell);
          if (num && num > 0) {
            results.push({
              id: uuidv4(), documentId, type: 'quantity',
              label:        `${colSchema.header}: ${rowLabel}`,
              rawValue:     getCellText(cell) || String(num),
              numericValue: num,
              unit:         colSchema.unit ?? undefined,
              context, sheetName, sectionTitle: rowSectionTitle, rowNumber: rowNum,
            });
          }

        } else if (type === 'party') {
          const text = getCellText(cell).trim();
          if (text.length > 1) {
            results.push({
              id: uuidv4(), documentId, type: 'party',
              label:    colSchema.header,
              rawValue: text,
              context, sheetName, sectionTitle: rowSectionTitle, rowNumber: rowNum,
            });
          }

        } else if (type === 'reference') {
          const text = getCellText(cell).trim();
          if (text) {
            results.push({
              id: uuidv4(), documentId, type: 'reference',
              label:    `${colSchema.header}: ${rowLabel}`,
              rawValue: text,
              context, sheetName, sectionTitle: rowSectionTitle, rowNumber: rowNum,
            });
          }

        } else if (type === 'duration') {
          const num  = getCellNumber(cell);
          const text = getCellText(cell).trim();
          if (num !== undefined || text) {
            results.push({
              id: uuidv4(), documentId, type: 'duration',
              label:        `${colSchema.header}: ${rowLabel}`,
              rawValue:     text || String(num),
              numericValue: num,
              unit:         colSchema.unit ?? undefined,
              context, sheetName, sectionTitle: rowSectionTitle, rowNumber: rowNum,
            });
          }

        } else if (type !== 'unit_rate') {
          // Novel open-ended type (risk_level, status, technical_score, …):
          // try numeric first, fall back to text. unit_rate is skipped here
          // because it is used only for the cost fallback below.
          const num      = getCellNumber(cell);
          const text     = getCellText(cell).trim();
          const rawValue = text || (num !== undefined ? String(num) : '');
          if (rawValue) {
            results.push({
              id: uuidv4(), documentId, type,
              label:        `${colSchema.header}: ${rowLabel}`,
              rawValue,
              numericValue: num,
              unit:         colSchema.unit ?? undefined,
              context, sheetName, sectionTitle: rowSectionTitle, rowNumber: rowNum,
            });
          }
        }
      }

      // Cost fallback: compute qty × unit_rate when the sheet has no direct cost column.
      if (!costEntry && unitRateEntry && qtyForRate) {
        const rate = getCellNumber(row.getCell(unitRateEntry[0]));
        const qty  = getCellNumber(row.getCell(qtyForRate[0]));
        if (rate && qty && rate > 0 && qty > 0) {
          results.push({
            id: uuidv4(), documentId, type: 'cost',
            label:        rowLabel,
            rawValue:     String(rate * qty),
            numericValue: rate * qty,
            unit:         activeCurrency,
            context, sheetName, sectionTitle: rowSectionTitle, rowNumber: rowNum,
          });
        }
      }
    }
  }

  return results;
}
