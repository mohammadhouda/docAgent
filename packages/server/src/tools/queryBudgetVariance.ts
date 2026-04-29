import { pool } from '../db/client.js';
import { ToolResult } from '../types/index.js';
import { buildSources, formatLocation } from './utils.js';

interface BudgetRow {
  cost_code:      string | null;
  category:       string;
  budget:         number;
  actual:         number;
  variance:       number;
  variance_pct:   number | null;
  sheet_name:     string | null;
  row_number:     number | null;
  page_number:    number | null;
  context:        string;
  file_name:      string;
}

// Query budget vs actual spending from cost tracking documents.
// Returns budget, actual, variance for each cost category, plus totals and over-budget items.
export async function queryBudgetVariance(args: {
  documentId?: string;
}): Promise<ToolResult> {
  const { documentId } = args;

  // Query looks for rows with budget and actual values
  // Handles various type names the LLM might assign:
  // - Budget: 'budget', 'budgeted_cost', 'planned_cost', 'baseline'
  // - Actual: 'actual', 'actual_cost', 'paid', 'spent', 'incurred', OR generic 'cost' when in same sheet as budget
  const result = await pool.query<BudgetRow>(
    `WITH budget_rows AS (
       -- Get budget values (any type containing 'budget', 'planned', 'baseline')
       SELECT 
         ev.document_id, ev.sheet_name, ev.row_number,
         ev.label AS category,
         COALESCE(ev.numeric_value, 0) AS budget,
         ev.context
       FROM extracted_values ev
       WHERE (ev.type ILIKE '%budget%' OR ev.type ILIKE '%planned%' OR ev.type ILIKE '%baseline%')
         AND ($1::uuid IS NULL OR ev.document_id = $1::uuid)
     ),
     actual_rows AS (
       -- Get actual values (any type containing 'actual', 'paid', 'spent', 'incurred')
       SELECT 
         ev.document_id, ev.sheet_name, ev.row_number,
         ev.label AS category,
         COALESCE(ev.numeric_value, 0) AS actual,
         ev.context
       FROM extracted_values ev
       WHERE (ev.type ILIKE '%actual%' OR ev.type ILIKE '%paid%' OR ev.type ILIKE '%spent%' OR ev.type ILIKE '%incurred%')
         AND ($1::uuid IS NULL OR ev.document_id = $1::uuid)
     ),
     -- If no actual rows found, try generic 'cost' type in sheets that have budget
     actual_fallback AS (
       SELECT 
         ev.document_id, ev.sheet_name, ev.row_number,
         ev.label AS category,
         COALESCE(ev.numeric_value, 0) AS actual,
         ev.context
       FROM extracted_values ev
       WHERE ev.type = 'cost'
         AND ($1::uuid IS NULL OR ev.document_id = $1::uuid)
         AND EXISTS (
           SELECT 1 FROM budget_rows br 
           WHERE br.document_id = ev.document_id AND br.sheet_name = ev.sheet_name
         )
     ),
     -- Combine actual sources, preferring explicit actual over fallback
     combined_actual AS (
       SELECT document_id, sheet_name, row_number, category, actual, context FROM actual_rows
       UNION
       SELECT document_id, sheet_name, row_number, category, actual, context 
       FROM actual_fallback af
       WHERE NOT EXISTS (
         SELECT 1 FROM actual_rows ar 
         WHERE ar.document_id = af.document_id AND ar.sheet_name = af.sheet_name AND ar.row_number = af.row_number
       )
     ),
     -- Aggregate by row to get budget + actual together
     aggregated AS (
       SELECT 
         COALESCE(b.document_id, a.document_id) AS document_id,
         COALESCE(b.sheet_name, a.sheet_name) AS sheet_name,
         COALESCE(b.row_number, a.row_number) AS row_number,
         COALESCE(b.category, a.category) AS category,
         COALESCE(b.context, a.context) AS context,
         COALESCE(b.budget, 0) AS budget,
         COALESCE(a.actual, 0) AS actual
       FROM budget_rows b
       FULL OUTER JOIN combined_actual a 
         ON b.document_id = a.document_id 
         AND b.sheet_name = a.sheet_name 
         AND b.row_number = a.row_number
       WHERE COALESCE(b.budget, 0) > 0 OR COALESCE(a.actual, 0) > 0
     )
     SELECT 
       ag.category,
       ag.budget,
       ag.actual,
       (ag.budget - ag.actual) AS variance,
       CASE WHEN ag.budget > 0 
         THEN ROUND(((ag.budget - ag.actual) / ag.budget * 100)::numeric, 2)
         ELSE NULL 
       END AS variance_pct,
       -- Try to extract cost code from nearby reference column
       (SELECT ev.raw_value FROM extracted_values ev 
        WHERE ev.document_id = ag.document_id AND ev.sheet_name = ag.sheet_name AND ev.row_number = ag.row_number 
          AND ev.type = 'reference' AND ev.raw_value ~ '^[A-Z]+-\d+$'
        LIMIT 1) AS cost_code,
       ag.sheet_name,
       ag.row_number,
       NULL::integer AS page_number,
       ag.context,
       d.file_name
     FROM aggregated ag
     JOIN documents d ON ag.document_id = d.id
     ORDER BY ag.budget DESC`,
    [documentId ?? null],
  );

  if (result.rows.length === 0) {
    return { success: false, data: 'No budget vs actual data found. The document may not have structured cost tracking data.', sources: [] };
  }

  const totalBudget = result.rows.reduce((sum, r) => sum + r.budget, 0);
  const totalActual = result.rows.reduce((sum, r) => sum + r.actual, 0);
  const totalVariance = totalBudget - totalActual;
  
  const overBudgetItems = result.rows.filter(r => r.actual > r.budget);
  const withinBudgetItems = result.rows.filter(r => r.actual <= r.budget);

  const items = result.rows.map((r) => ({
    costCode:    r.cost_code,
    category:    r.category,
    budget:      r.budget,
    actual:      r.actual,
    variance:    r.variance,
    variancePct: r.variance_pct,
    isOverBudget: r.actual > r.budget,
    source:      r.file_name,
    location:    formatLocation(r),
  }));

  return {
    success: true,
    data: {
      totalBudget,
      totalActual,
      totalVariance,
      totalItems: result.rows.length,
      overBudgetCount: overBudgetItems.length,
      currency: 'SAR',
      overBudgetItems: overBudgetItems.map(r => ({
        costCode: r.cost_code,
        category: r.category,
        budget: r.budget,
        actual: r.actual,
        overBy: r.actual - r.budget,
      })),
      allItems: items,
    },
    sources: buildSources(result.rows),
  };
}
