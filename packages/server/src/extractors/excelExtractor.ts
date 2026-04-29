import ExcelJS from 'exceljs';
import { v4 as uuidv4 } from 'uuid';
import { ExtractedValue } from './types.js';
import { openaiClient } from '../services/openai.js';

// ─── LLM-driven schema inference ─────────────────────────────────────────────

type ColRole = 'label' | 'item_no' | 'value' | 'skip';

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
               "label"   the primary description / name of each row item
               "item_no" sequential item number, code, or reference prefix
               "value"   a column worth extracting structured data from
               "skip"    row counters, blank columns, footnotes, or anything not useful
  type     — required when role is "value"; use a standard type where it fits:
                cost, date, percentage, quantity, party, reference, duration, unit_rate
             or invent a descriptive snake_case type for anything else:
                risk_level, status, completion_rate, technical_score, weighted_score …
             If multiple columns are monetary, mark the most authoritative one "cost"
             and the others with specific names (budgeted_cost, committed_cost, …).
  unit     — optional: SAR, AED, USD, %, m², m³, months, days, …

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

// ─── Row-level guard ──────────────────────────────────────────────────────────

// Skip grand-total / sub-total rows — they are aggregates, not line items.
const TOTAL_ROW_RE = /^\s*(grand\s+)?(sub\s*)?total\b|^\s*vat\b/i;

// ─── Main extractor ───────────────────────────────────────────────────────────

export async function extractFromWorkbook(
  workbook: ExcelJS.Workbook,
  documentId: string,
): Promise<ExtractedValue[]> {
  const results: ExtractedValue[] = [];

  for (const ws of workbook.worksheets) {
    if (ws.rowCount === 0) continue;
    const sheetName = ws.name;

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

    // Map actual Excel colNum → ColSchema using the LLM's 1-based colIndex.
    const schemaByColNum = new Map<number, ColSchema>();
    let labelColNum:  number | null = null;
    let itemNoColNum: number | null = null;

    for (const entry of schema) {
      const hc = headerCols[entry.colIndex - 1];
      if (!hc) continue;
      schemaByColNum.set(hc.colNum, entry);
      if (entry.role === 'label'   && labelColNum  === null) labelColNum  = hc.colNum;
      if (entry.role === 'item_no' && itemNoColNum === null) itemNoColNum = hc.colNum;
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
    for (let rowNum = headerRowNum + 1; rowNum <= ws.rowCount; rowNum++) {
      const row = ws.getRow(rowNum);

      const labelCell   = labelColNum  ? row.getCell(labelColNum)  : null;
      const itemNoCell  = itemNoColNum ? row.getCell(itemNoColNum) : null;
      const description = labelCell ? getCellText(labelCell).trim() : '';
      if (!description || TOTAL_ROW_RE.test(description)) continue;

      const itemNo   = itemNoCell ? getCellText(itemNoCell).trim() : '';
      const rowLabel = itemNo ? `${itemNo}: ${description}` : description;

      // Compact context string from all non-empty cells
      const parts: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell, colNum) => {
        const val = getCellText(cell).trim();
        if (val) {
          const s = schemaByColNum.get(colNum);
          parts.push(`${s?.header ?? `C${colNum}`}: ${val}`);
        }
      });
      if (parts.length === 0) continue;
      const context = `[${sheetName}] ${parts.join(' | ')}`.slice(0, 300);

      // Extract each value column using the LLM-assigned type.
      for (const [colNum, colSchema] of valueColumns) {
        const cell = row.getCell(colNum);
        const type = colSchema.type!;

        if (type === 'cost') {
          const num = getCellNumber(cell);
          if (num && num > 0) {
            results.push({
              id: uuidv4(), documentId, type: 'cost',
              label:        rowLabel,
              rawValue:     getCellText(cell) || String(num),
              numericValue: num,
              unit:         colSchema.unit?.toUpperCase() ?? activeCurrency,
              context, sheetName, rowNumber: rowNum,
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
              context, sheetName, rowNumber: rowNum,
            });
          }

        } else if (type === 'percentage') {
          const num = getCellNumber(cell);
          if (num !== undefined) {
            const pct = isPercentFormat(cell) ? num * 100 : num;
            if (pct > 0 && pct <= 100) {
              results.push({
                id: uuidv4(), documentId, type: 'percentage',
                label:        `${colSchema.header}: ${rowLabel}`,
                rawValue:     getCellText(cell) || `${pct}%`,
                numericValue: pct,
                unit:         '%',
                context, sheetName, rowNumber: rowNum,
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
              context, sheetName, rowNumber: rowNum,
            });
          }

        } else if (type === 'party') {
          const text = getCellText(cell).trim();
          if (text.length > 1) {
            results.push({
              id: uuidv4(), documentId, type: 'party',
              label:    colSchema.header,
              rawValue: text,
              context, sheetName, rowNumber: rowNum,
            });
          }

        } else if (type === 'reference') {
          const text = getCellText(cell).trim();
          if (text) {
            results.push({
              id: uuidv4(), documentId, type: 'reference',
              label:    `${colSchema.header}: ${rowLabel}`,
              rawValue: text,
              context, sheetName, rowNumber: rowNum,
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
              context, sheetName, rowNumber: rowNum,
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
              context, sheetName, rowNumber: rowNum,
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
            context, sheetName, rowNumber: rowNum,
          });
        }
      }
    }
  }

  return results;
}
