import { pool } from '../db/client.js';
import { ToolResult } from '../types/index.js';
import { likeParam } from './utils.js';

interface UnitRateRow {
  item:      string;
  cost:      number;
  quantity:  number;
  unit:      string | null;
  unit_rate: number;
  sheet_name: string | null;
  row_number: number | null;
  file_name: string;
}

async function unitRate(documentId?: string, item?: string): Promise<ToolResult> {
  const result = await pool.query<UnitRateRow>(
    `SELECT
       c.label                                    AS item,
       c.numeric_value                            AS cost,
       q.numeric_value                            AS quantity,
       q.unit,
       (c.numeric_value / q.numeric_value)::float AS unit_rate,
       c.sheet_name,
       c.row_number,
       d.file_name
     FROM extracted_values c
     JOIN documents d ON c.document_id = d.id
     JOIN extracted_values q
       ON  q.document_id  = c.document_id
       AND q.type         = 'quantity'
       AND q.numeric_value > 0
       AND q.row_number   = c.row_number
       AND (q.sheet_name = c.sheet_name OR (q.sheet_name IS NULL AND c.sheet_name IS NULL))
     WHERE c.type = 'cost'
       AND c.numeric_value IS NOT NULL
       AND ($1::uuid IS NULL OR c.document_id = $1::uuid)
       AND ($2::text IS NULL OR c.label ILIKE $2)
     ORDER BY c.numeric_value DESC
     LIMIT 100`,
    [documentId ?? null, likeParam(item)],
  );

  if (result.rows.length === 0) {
    return {
      success: false,
      data: item
        ? `No items matching "${item}" with both cost and quantity on the same row.`
        : 'No rows with both cost and quantity found.',
      sources: [],
    };
  }

  return {
    success: true,
    data: {
      items: result.rows.map((r) => ({
        item:     r.item,
        cost:     r.cost,
        quantity: r.quantity,
        unit:     r.unit ?? 'unit',
        unitRate: Math.round(r.unit_rate * 100) / 100,
        location: r.sheet_name ? `Sheet: ${r.sheet_name}, Row ${r.row_number}` : '',
        document: r.file_name,
      })),
    },
    sources: result.rows.map((r) => ({
      documentName: r.file_name,
      location:     r.sheet_name ? `Sheet: ${r.sheet_name}, Row ${r.row_number}` : '',
      excerpt:      `${r.item} — ${r.cost.toLocaleString()} ÷ ${r.quantity} ${r.unit ?? ''} = ${r.unit_rate.toFixed(2)} per ${r.unit ?? 'unit'}`,
    })),
  };
}

/**
 * Generic arithmetic tool — replaces compute_difference, compute_sum, apply_percentage, calculate_unit_rate.
 *
 * operations:
 *   'sum'        — add an array of values; returns total + optional breakdown
 *   'difference' — valueA − valueB with absolute diff and percentage gap
 *   'ratio'      — part/whole × 100 (what % is part of whole?)
 *   'apply_rate' — apply a percentage rate to a base (add for VAT/markup, subtract for retention/discount)
 *   'unit_rate'  — DB lookup: cost ÷ quantity for BOQ rows that have both columns
 */
export async function computeResult(args: {
  operation:    'sum' | 'difference' | 'ratio' | 'apply_rate' | 'unit_rate';
  // sum
  values?:      number[];
  labels?:      string[];
  resultLabel?: string;
  // difference
  valueA?:      number;
  labelA?:      string;
  valueB?:      number;
  labelB?:      string;
  // ratio
  part?:        number;
  whole?:       number;
  partLabel?:   string;
  wholeLabel?:  string;
  // apply_rate
  baseAmount?:  number;
  rate?:        number;
  direction?:   'add' | 'subtract';
  labelBase?:   string;
  labelRate?:   string;
  // unit_rate (DB-backed)
  documentId?:  string;
  item?:        string;
}): Promise<ToolResult> {
  const { operation } = args;

  if (operation === 'sum') {
    const { values = [], labels, resultLabel = 'Total' } = args;
    const valid = values.filter((v) => typeof v === 'number' && !isNaN(v));
    if (valid.length === 0) {
      return { success: false, data: 'No valid numeric values to sum.', sources: [] };
    }
    const total = valid.reduce((s, v) => s + v, 0);
    const breakdown = labels && labels.length === valid.length
      ? valid.map((v, i) => ({ label: labels[i], value: v }))
      : undefined;
    return {
      success: true,
      data: { label: resultLabel, total, count: valid.length, breakdown },
      sources: [],
    };
  }

  if (operation === 'difference') {
    const { valueA, valueB, labelA = 'Value A', labelB = 'Value B' } = args;
    if (valueA === undefined || valueB === undefined) {
      return { success: false, data: 'difference requires valueA and valueB.', sources: [] };
    }
    const difference         = valueA - valueB;
    const absoluteDifference = Math.abs(difference);
    const percentageDifference = valueB !== 0
      ? Math.round((difference / valueB) * 10000) / 100
      : null;
    return {
      success: true,
      data: {
        [labelA]: valueA,
        [labelB]: valueB,
        difference,
        absoluteDifference,
        percentageDifference,
        higher: difference >= 0 ? labelA : labelB,
        lower:  difference >= 0 ? labelB : labelA,
      },
      sources: [],
    };
  }

  if (operation === 'ratio') {
    const { part, whole, partLabel = 'Part', wholeLabel = 'Whole' } = args;
    if (part === undefined || whole === undefined) {
      return { success: false, data: 'ratio requires part and whole.', sources: [] };
    }
    if (whole === 0) {
      return { success: false, data: 'Cannot compute ratio: whole is zero.', sources: [] };
    }
    const percentage = Math.round((part / whole) * 10000) / 100;
    return {
      success: true,
      data: { [partLabel]: part, [wholeLabel]: whole, percentage, interpretation: `${partLabel} is ${percentage}% of ${wholeLabel}` },
      sources: [],
    };
  }

  if (operation === 'apply_rate') {
    const {
      baseAmount,
      rate,
      direction  = 'add',
      labelBase  = 'Base amount',
      labelRate  = 'Rate',
    } = args;
    if (baseAmount === undefined || rate === undefined) {
      return { success: false, data: 'apply_rate requires baseAmount and rate.', sources: [] };
    }
    const percentageAmount = Math.round((baseAmount * rate) / 100 * 100) / 100;
    const result = direction === 'add'
      ? Math.round((baseAmount + percentageAmount) * 100) / 100
      : Math.round((baseAmount - percentageAmount) * 100) / 100;
    return {
      success: true,
      data: {
        [labelBase]:                   baseAmount,
        [`${labelRate} (${rate}%)`]:   percentageAmount,
        [`Total (${direction === 'add' ? 'inclusive' : 'exclusive'})`]: result,
        direction,
        rate,
      },
      sources: [],
    };
  }

  if (operation === 'unit_rate') {
    return unitRate(args.documentId, args.item);
  }

  return { success: false, data: `Unknown operation: ${operation}`, sources: [] };
}
