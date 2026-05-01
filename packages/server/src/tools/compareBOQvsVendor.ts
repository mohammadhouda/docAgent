import { pool } from '../db/client.js';
import { ToolResult } from '../types/index.js';

interface CategoryComparisonRow {
  category: string;
  boq_total: number | null;
  vendor_total: number | null;
  variance: number | null;
  variance_pct: number | null;
  boq_item_count: number;
  vendor_item_count: number;
  boq_doc: string;
  vendor_doc: string;
}

/**
 * Compares cost categories between BOQ and Vendor Payment Register documents.
 * Identifies mismatches, gaps, and inconsistencies between the two.
 */
export async function compareBOQvsVendor(args: {
  boqDocumentId?: string;
  vendorDocumentId?: string;
}): Promise<ToolResult> {
  const { boqDocumentId, vendorDocumentId } = args;

  // Get BOQ category totals
  const boqResult = await pool.query<{
    category: string;
    total: number | null;
    item_count: number;
    doc_name: string;
  }>(
    `SELECT 
       COALESCE(ev.section_title, 'Uncategorized') AS category,
       SUM(ev.numeric_value)::float AS total,
       COUNT(*)::int AS item_count,
       d.file_name AS doc_name
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type IN ('cost', 'budget', 'contract_value')
       AND ev.numeric_value IS NOT NULL
       AND LOWER(COALESCE(ev.sheet_name, '')) NOT SIMILAR TO '%(summary|rollup|consolidated)%'
       ${boqDocumentId ? 'AND ev.document_id = $1::uuid' : ''}
       AND (
         d.file_name ILIKE '%BOQ%' OR 
         d.file_name ILIKE '%Riyadh_Tower%'
       )
     GROUP BY COALESCE(ev.section_title, 'Uncategorized'), d.file_name
     ORDER BY total DESC`,
    boqDocumentId ? [boqDocumentId] : [],
  );

  // Get Vendor Register category totals (using Service Type as category)
  const vendorResult = await pool.query<{
    category: string;
    total: number | null;
    item_count: number;
    doc_name: string;
  }>(
    `SELECT 
       COALESCE(ev.section_title, 'Uncategorized') AS category,
       SUM(ev.numeric_value)::float AS total,
       COUNT(*)::int AS item_count,
       d.file_name AS doc_name
     FROM extracted_values ev
     JOIN documents d ON ev.document_id = d.id
     WHERE ev.type IN ('cost', 'budget', 'contract_value')
       AND ev.numeric_value IS NOT NULL
       ${vendorDocumentId ? 'AND ev.document_id = $1::uuid' : ''}
       AND (
         d.file_name ILIKE '%Vendor%' OR 
         d.file_name ILIKE '%Payment%'
       )
     GROUP BY COALESCE(ev.section_title, 'Uncategorized'), d.file_name
     ORDER BY total DESC`,
    vendorDocumentId ? [vendorDocumentId] : [],
  );

  if (boqResult.rows.length === 0 && vendorResult.rows.length === 0) {
    return {
      success: false,
      data: 'No BOQ or Vendor Register documents found for comparison.',
      sources: [],
    };
  }

  // Build comparison map
  const boqMap = new Map(boqResult.rows.map(r => [r.category.toLowerCase(), r]));
  const vendorMap = new Map(vendorResult.rows.map(r => [r.category.toLowerCase(), r]));

  const allCategories = new Set([...boqMap.keys(), ...vendorMap.keys()]);
  
  const comparisons: CategoryComparisonRow[] = [];
  
  for (const category of allCategories) {
    const boq = boqMap.get(category);
    const vendor = vendorMap.get(category);
    
    const boqTotal = boq?.total ?? null;
    const vendorTotal = vendor?.total ?? null;
    const variance = boqTotal && vendorTotal ? boqTotal - vendorTotal : null;
    const variancePct = boqTotal && variance ? (variance / boqTotal) * 100 : null;
    
    comparisons.push({
      category: boq?.category || vendor?.category || category,
      boq_total: boqTotal,
      vendor_total: vendorTotal,
      variance,
      variance_pct: variancePct ? Math.round(variancePct * 100) / 100 : null,
      boq_item_count: boq?.item_count ?? 0,
      vendor_item_count: vendor?.item_count ?? 0,
      boq_doc: boq?.doc_name || 'N/A',
      vendor_doc: vendor?.doc_name || 'N/A',
    });
  }

  // Sort by variance (largest gaps first)
  comparisons.sort((a, b) => Math.abs(b.variance || 0) - Math.abs(a.variance || 0));

  // Calculate totals
  const boqGrandTotal = boqResult.rows.reduce((s, r) => s + (r.total ?? 0), 0);
  const vendorGrandTotal = vendorResult.rows.reduce((s, r) => s + (r.total ?? 0), 0);
  const grandVariance = boqGrandTotal - vendorGrandTotal;
  const grandVariancePct = (grandVariance / boqGrandTotal) * 100;

  // Identify inconsistencies
  const inconsistencies: string[] = [];
  
  // Check for categories in BOQ but not in Vendor Register
  const missingInVendor = comparisons.filter(c => c.boq_total && !c.vendor_total);
  if (missingInVendor.length > 0) {
    inconsistencies.push(`${missingInVendor.length} BOQ categories have no corresponding vendor register entries.`);
  }
  
  // Check for categories in Vendor Register but not in BOQ
  const missingInBOQ = comparisons.filter(c => c.vendor_total && !c.boq_total);
  if (missingInBOQ.length > 0) {
    inconsistencies.push(`${missingInBOQ.length} vendor register categories have no corresponding BOQ entries.`);
  }
  
  // Check for significant variances (>10% difference)
  const significantVariances = comparisons.filter(c => 
    c.variance_pct !== null && Math.abs(c.variance_pct) > 10 && c.boq_total && c.vendor_total
  );
  if (significantVariances.length > 0) {
    inconsistencies.push(`${significantVariances.length} categories have >10% variance between BOQ and vendor register.`);
  }
  
  // Check for total mismatch
  if (Math.abs(grandVariancePct) > 5) {
    inconsistencies.push(`Grand total variance is ${grandVariancePct.toFixed(1)}% (BOQ: ${boqGrandTotal.toLocaleString()}, Vendor: ${vendorGrandTotal.toLocaleString()}).`);
  }

  return {
    success: true,
    data: {
      summary: {
        boqGrandTotal,
        vendorGrandTotal,
        grandVariance,
        grandVariancePct: Math.round(grandVariancePct * 100) / 100,
        totalCategories: allCategories.size,
        categoriesInBoth: comparisons.filter(c => c.boq_total && c.vendor_total).length,
        onlyInBOQ: missingInVendor.length,
        onlyInVendor: missingInBOQ.length,
      },
      inconsistencies,
      comparisons: comparisons.map(c => ({
        category: c.category,
        boqTotal: c.boq_total,
        vendorTotal: c.vendor_total,
        variance: c.variance,
        variancePct: c.variance_pct,
        boqItemCount: c.boq_item_count,
        vendorItemCount: c.vendor_item_count,
      })),
    },
    sources: [
      ...(boqResult.rows.length > 0 ? [{
        documentName: boqResult.rows[0].doc_name,
        location: 'Category breakdown',
        excerpt: `${boqResult.rows.length} categories, total: ${boqGrandTotal.toLocaleString()} SAR`,
      }] : []),
      ...(vendorResult.rows.length > 0 ? [{
        documentName: vendorResult.rows[0].doc_name,
        location: 'Category breakdown',
        excerpt: `${vendorResult.rows.length} categories, total: ${vendorGrandTotal.toLocaleString()} SAR`,
      }] : []),
    ],
  };
}
