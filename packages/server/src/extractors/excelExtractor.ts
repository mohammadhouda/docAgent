import ExcelJS from 'exceljs';
import { v4 as uuidv4 } from 'uuid';
import { ExtractedValue, ValueType } from './types.js';

// ─── Column classification patterns ──────────────────────────────────────────

const HEADER_PATTERNS: Array<{ type: ValueType; pattern: RegExp }> = [
  // Currency codes excluded — they appear in non-cost headers like "Variance (SAR)"
  { type: 'cost',       pattern: /amount|total|cost|price|budget|value|rate|sum|subtotal|net|gross|tender|contract\s*value/i },
  { type: 'date',       pattern: /\bdate\b|deadline|due\s*date|delivery|completion|milestone|handover|expiry|submission|issued?/i },
  { type: 'percentage', pattern: /percent|vat|tax|margin|retention|markup|discount|overhead|profit|\b%/i },
  { type: 'duration',   pattern: /duration|period|weeks|months|days|timeline|programme/i },
  { type: 'quantity',   pattern: /quantity|qty|\barea\b|volume|length|width|height|weight|m2|m²|m3|m³|\blm\b|count|no\.\s*of/i },
  { type: 'party',      pattern: /contractor|client|employer|subcontractor|vendor|supplier|consultant|designer|owner/i },
  { type: 'reference',  pattern: /\bref\b|reference|drawing|clause|article|\bcode\b|spec\.?\s*no|contract\s*no/i },
];

// Description/category columns — used as the human-readable row label
const LABEL_HEADER_RE = /\bdescription\b|\bactivity\b|\bitem\s*name\b|\bcategory\b|\bdetails?\b|\bscope\b/i;

// Item number/reference columns — prepended to label so output reads "A-001: Description"
const ITEM_NO_HEADER_RE = /^(item\s*)?(no\.?|num\.?|code|#|id)$|^s\.?\s*no\.?$|^sl\.?\s*no\.?$|^ref\.?$/i;

// Per-unit pricing columns — excluded to avoid duplicating the Total Amount on LS (qty=1) rows
const UNIT_RATE_RE = /unit\s*rate|rate\s+per\s+unit/i;

// Row labels that indicate a computed total/summary — not individual cost items
const TOTAL_ROW_RE = /^\s*(grand\s+)?(sub\s*)?total\b|^\s*vat\b/i;

// Cost column priority: lower index = preferred. When multiple cost columns exist per row,
// only the highest-priority column is extracted to avoid Committed/Budgeted duplication.
const COST_COL_PRIORITY: RegExp[] = [
  /committed|actual|contract\s+(amount|value)/i,  // 0: authoritative contract figure
  /total\s*amount|^total$/i,                       // 1: explicit sum column
  /\bamount\b/i,                                   // 2: plain "Amount" column
];

function costColPriority(header: string): number {
  for (let i = 0; i < COST_COL_PRIORITY.length; i++) {
    if (COST_COL_PRIORITY[i].test(header)) return i;
  }
  return COST_COL_PRIORITY.length;
}

function classifyHeader(header: string): ValueType | null {
  for (const { type, pattern } of HEADER_PATTERNS) {
    if (pattern.test(header)) return type;
  }
  return null;
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

// ─── Main extractor ───────────────────────────────────────────────────────────

export function extractFromWorkbook(
  workbook: ExcelJS.Workbook,
  documentId: string,
): ExtractedValue[] {
  const results: ExtractedValue[] = [];

  for (const ws of workbook.worksheets) {
    if (ws.rowCount === 0) continue;
    const sheetName = ws.name;

    // Find the real header row: first row with ≥2 distinct non-empty cell values.
    // Merged title rows (all cells same text) and blank rows are skipped.
    let headerRowNum = 1;
    for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
      const distinctVals = new Set<string>();
      ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
        const text = getCellText(cell).trim();
        if (text) distinctVals.add(text);
      });
      if (distinctVals.size >= 2) { headerRowNum = r; break; }
    }

    // ── Identify special columns from the header row ──────────────────────────
    type ColMeta = { colNum: number; header: string; type: ValueType };
    const typedCols: ColMeta[] = [];
    let labelColNum:  number | null = null;
    let itemNoColNum: number | null = null;

    // Pass 1: find description column and item-number column by header name
    ws.getRow(headerRowNum).eachCell({ includeEmpty: false }, (cell, colNum) => {
      const header = getCellText(cell).trim();
      if (LABEL_HEADER_RE.test(header)  && labelColNum  === null) labelColNum  = colNum;
      if (ITEM_NO_HEADER_RE.test(header) && itemNoColNum === null) itemNoColNum = colNum;
    });

    // Pass 2: classify typed columns; first unclassified col is the fallback label
    ws.getRow(headerRowNum).eachCell({ includeEmpty: false }, (cell, colNum) => {
      const header = getCellText(cell).trim();
      if (!header) return;
      const type = classifyHeader(header);
      if (type) {
        typedCols.push({ colNum, header, type });
      } else if (labelColNum === null && colNum !== itemNoColNum) {
        labelColNum = colNum;
      }
    });

    if (typedCols.length === 0) continue;

    // Sheets without an item-number column are summary/aggregate sheets — skip cost extraction.
    const costCols = itemNoColNum === null ? [] : typedCols.filter((c) => c.type === 'cost');

    // Primary cost column: highest-priority non-unit-rate column
    // (committed > total amount > amount > any other cost column)
    const primaryCostCol = costCols
      .filter((c) => !UNIT_RATE_RE.test(c.header))
      .sort((a, b) => costColPriority(a.header) - costColPriority(b.header))[0] ?? null;

    // Fallback: if no total/amount column exists, derive cost from Quantity × Unit Rate
    const rateCol = primaryCostCol === null
      ? (costCols.find((c) => UNIT_RATE_RE.test(c.header)) ?? costCols[0] ?? null)
      : null;
    const qtyCol  = rateCol !== null
      ? (typedCols.find((c) => c.type === 'quantity') ?? null)
      : null;

    // Determine the currency from whichever cost column we'll be reading
    const activeCostCol = primaryCostCol ?? rateCol;
    const activeCurrency = activeCostCol?.header.match(/\b(SAR|AED|USD|QAR|KWD|OMR|EUR|GBP)\b/i)?.[1]?.toUpperCase() ?? 'SAR';

    // ── Walk data rows ────────────────────────────────────────────────────────
    for (let rowNum = headerRowNum + 1; rowNum <= ws.rowCount; rowNum++) {
      const row = ws.getRow(rowNum);

      // Description must be present — skip totals, blanks, and section headers
      const labelCell  = labelColNum  ? row.getCell(labelColNum)  : null;
      const itemNoCell = itemNoColNum ? row.getCell(itemNoColNum) : null;
      const description = labelCell ? getCellText(labelCell).trim() : '';
      if (!description || TOTAL_ROW_RE.test(description)) continue;

      const itemNo  = itemNoCell ? getCellText(itemNoCell).trim() : '';
      const rowLabel = itemNo ? `${itemNo}: ${description}` : description;

      // Build compact context string from all non-empty cells
      const parts: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell, colNum) => {
        const val = getCellText(cell).trim();
        if (val) {
          const col = typedCols.find((c) => c.colNum === colNum);
          parts.push(`${col?.header ?? `C${colNum}`}: ${val}`);
        }
      });
      if (parts.length === 0) continue;
      const context = `[${sheetName}] ${parts.join(' | ')}`.slice(0, 300);

      // ── Cost extraction (single value per row) ─────────────────────────────
      {
        let num: number | undefined;
        let rawValue = '';

        if (primaryCostCol) {
          // Direct column: committed / total amount / amount / any other cost col
          const cell = row.getCell(primaryCostCol.colNum);
          num      = getCellNumber(cell);
          rawValue = getCellText(cell);
        } else if (rateCol && qtyCol) {
          // Fallback: derive total from Quantity × Unit Rate
          const rate = getCellNumber(row.getCell(rateCol.colNum));
          const qty  = getCellNumber(row.getCell(qtyCol.colNum));
          if (rate && qty) { num = rate * qty; rawValue = String(num); }
        }

        if (num && num > 0) {
          results.push({
            id: uuidv4(), documentId, type: 'cost',
            label:        rowLabel,
            rawValue:     rawValue || String(num),
            numericValue: num,
            unit:         activeCurrency,
            context, sheetName, rowNumber: rowNum,
          });
        }
      }

      // ── Other typed columns ─────────────────────────────────────────────────
      for (const col of typedCols) {
        if (col.type === 'cost') continue; // already handled above
        const cell = row.getCell(col.colNum);

        if (col.type === 'date') {
          const d = getCellDate(cell);
          if (d) {
            results.push({
              id: uuidv4(), documentId, type: 'date',
              label:    `${col.header}: ${rowLabel}`,
              rawValue: d.toLocaleDateString('en-GB'),
              dateValue: d,
              context, sheetName, rowNumber: rowNum,
            });
          }
        }

        else if (col.type === 'percentage') {
          const num = getCellNumber(cell);
          if (num !== undefined) {
            const pct = isPercentFormat(cell) ? num * 100 : num;
            if (pct > 0 && pct <= 100) {
              results.push({
                id: uuidv4(), documentId, type: 'percentage',
                label:        `${col.header}: ${rowLabel}`,
                rawValue:     getCellText(cell) || `${pct}%`,
                numericValue: pct, unit: '%',
                context, sheetName, rowNumber: rowNum,
              });
            }
          }
        }

        else if (col.type === 'quantity') {
          const num = getCellNumber(cell);
          if (num && num > 0) {
            const unitMatch = col.header.match(/m2|m²|m3|m³|lm|kg|ton|tonne/i);
            results.push({
              id: uuidv4(), documentId, type: 'quantity',
              label:        `${col.header}: ${rowLabel}`,
              rawValue:     getCellText(cell) || String(num),
              numericValue: num,
              unit:         unitMatch ? unitMatch[0] : undefined,
              context, sheetName, rowNumber: rowNum,
            });
          }
        }

        else if (col.type === 'duration') {
          const num  = getCellNumber(cell);
          const text = getCellText(cell).trim();
          if (num || text) {
            const unitMatch = (text + col.header).match(/days?|weeks?|months?|years?/i);
            results.push({
              id: uuidv4(), documentId, type: 'duration',
              label:        `${col.header}: ${rowLabel}`,
              rawValue:     text || String(num),
              numericValue: num,
              unit:         unitMatch ? unitMatch[0].toLowerCase() : undefined,
              context, sheetName, rowNumber: rowNum,
            });
          }
        }

        else if (col.type === 'party') {
          const text = getCellText(cell).trim();
          if (text.length > 1) {
            results.push({
              id: uuidv4(), documentId, type: 'party',
              label:    col.header,
              rawValue: text,
              context, sheetName, rowNumber: rowNum,
            });
          }
        }

        else if (col.type === 'reference') {
          const text = getCellText(cell).trim();
          if (text) {
            results.push({
              id: uuidv4(), documentId, type: 'reference',
              label:    `${col.header}: ${rowLabel}`,
              rawValue: text,
              context, sheetName, rowNumber: rowNum,
            });
          }
        }
      }
    }
  }

  return results;
}
