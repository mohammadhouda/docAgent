import { pool } from '../db/client.js';
import { ToolResult } from '../types/index.js';

// ─── Keyword matching ────────────────────────────────────────────────────────

// Words that appear in many construction items and carry no discriminating signal.
const STOP_WORDS = new Set([
  'and', 'or', 'the', 'of', 'for', 'in', 'on', 'at', 'to', 'a', 'an',
  'with', 'by', 'from', 'all', 'any', 'per',
  'works', 'work', 'supply', 'supplies', 'install', 'installation', 'installed',
  'system', 'systems', 'services', 'service', 'general', 'misc',
]);

const MATCH_THRESHOLD = 0.15; // minimum Jaccard similarity to count as a match

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      // strip leading item-number prefixes like "A.01", "1.2.3:", "MEP-01 -"
      .replace(/^[\w.-]+\s*[-:.]\s*/, '')
      .replace(/[^a-z0-9\s&]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1 && !STOP_WORDS.has(w)),
  );
}

function jaccardSim(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 0;
  const inter = [...ta].filter(w => tb.has(w)).length;
  const union = new Set([...ta, ...tb]).size;
  return inter / union;
}

// ─── Item types ───────────────────────────────────────────────────────────────

interface ItemRow {
  label:         string;
  numeric_value: number;
  section_title: string | null;
  file_name:     string;
  doc_id:        string;
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

export async function compareBOQvsVendor(args: {
  boqDocumentId?:    string;
  vendorDocumentId?: string;
}): Promise<ToolResult> {
  const { boqDocumentId, vendorDocumentId } = args;

  // Individual BOQ line items (not aggregated — each row is one item).
  // Exclude summary/rollup sheets to avoid double-counting.
  const boqQ = await pool.query<ItemRow>(
    `SELECT ev.label,
            ev.numeric_value::float         AS numeric_value,
            ev.section_title,
            d.file_name,
            d.id                            AS doc_id
       FROM extracted_values ev
       JOIN documents d ON ev.document_id = d.id
      WHERE ev.type IN ('cost', 'budget', 'contract_value')
        AND ev.numeric_value > 0
        AND ($1::uuid IS NULL OR ev.document_id = $1::uuid)
        AND (d.file_name ILIKE '%BOQ%' OR d.profile->>'documentType' = 'boq')
        AND LOWER(COALESCE(ev.sheet_name,'')) NOT SIMILAR TO '%(summary|rollup|consolidated)%'
      ORDER BY ev.numeric_value DESC
      LIMIT 300`,
    [boqDocumentId ?? null],
  );

  // Individual Vendor Register entries. For each vendor row:
  //   label        = vendor name (or item description)
  //   section_title = scope of work (e.g. "Curtain Wall Glazing") — used for matching
  const vendorQ = await pool.query<ItemRow>(
    `SELECT ev.label,
            ev.numeric_value::float         AS numeric_value,
            ev.section_title,
            d.file_name,
            d.id                            AS doc_id
       FROM extracted_values ev
       JOIN documents d ON ev.document_id = d.id
      WHERE ev.type IN ('cost', 'budget', 'contract_value')
        AND ev.numeric_value > 0
        AND ($1::uuid IS NULL OR ev.document_id = $1::uuid)
        AND (d.file_name ILIKE '%Vendor%' OR d.file_name ILIKE '%Payment%')
      ORDER BY ev.numeric_value DESC
      LIMIT 300`,
    [vendorDocumentId ?? null],
  );

  if (boqQ.rows.length === 0 && vendorQ.rows.length === 0) {
    return { success: false, data: 'No BOQ or Vendor Register documents found.', sources: [] };
  }

  const boqDocName    = boqQ.rows[0]?.file_name    ?? 'BOQ';
  const vendorDocName = vendorQ.rows[0]?.file_name ?? 'Vendor Register';

  // For each vendor entry, the text we match against is the scope/section_title
  // (e.g. "Curtain Wall Glazing"), falling back to the label (vendor name).
  const vendorEntries = vendorQ.rows.map(r => ({
    ...r,
    scopeText: (r.section_title ?? r.label).trim(),
  }));

  // ── Match BOQ items to Vendor scopes ────────────────────────────────────────

  // vendorKey → { total BOQ amount, individual BOQ labels }
  const vendorMatchedBOQ = new Map<string, { boqTotal: number; boqLabels: string[] }>();
  const unmatchedBOQ: ItemRow[] = [];

  for (const boqItem of boqQ.rows) {
    let bestKey = '';
    let bestSim = MATCH_THRESHOLD;

    for (const v of vendorEntries) {
      const sim = jaccardSim(boqItem.label, v.scopeText);
      if (sim > bestSim) {
        bestSim = sim;
        bestKey = v.scopeText;
      }
    }

    if (bestKey) {
      const existing = vendorMatchedBOQ.get(bestKey) ?? { boqTotal: 0, boqLabels: [] };
      existing.boqTotal += boqItem.numeric_value;
      existing.boqLabels.push(boqItem.label);
      vendorMatchedBOQ.set(bestKey, existing);
    } else {
      unmatchedBOQ.push(boqItem);
    }
  }

  // ── Build comparison rows ────────────────────────────────────────────────────

  // De-duplicate vendor entries by scope (sum if multiple rows share scope).
  const vendorByScope = new Map<string, number>();
  for (const v of vendorEntries) {
    vendorByScope.set(v.scopeText, (vendorByScope.get(v.scopeText) ?? 0) + v.numeric_value);
  }

  interface CompRow {
    scope:           string;
    boqTotal:        number | null;
    vendorTotal:     number | null;
    variance:        number | null;
    variancePct:     number | null;
    boqLabels:       string[];
  }

  const matched: CompRow[] = [];
  const vendorOnlyScopes: CompRow[] = [];

  for (const [scope, vendorTotal] of vendorByScope) {
    const boqData = vendorMatchedBOQ.get(scope);
    if (boqData) {
      const variance    = boqData.boqTotal - vendorTotal;
      const variancePct = (variance / vendorTotal) * 100;
      matched.push({
        scope,
        boqTotal:    boqData.boqTotal,
        vendorTotal,
        variance,
        variancePct: Math.round(variancePct * 10) / 10,
        boqLabels:   boqData.boqLabels,
      });
    } else {
      vendorOnlyScopes.push({
        scope,
        boqTotal:    null,
        vendorTotal,
        variance:    null,
        variancePct: null,
        boqLabels:   [],
      });
    }
  }

  // Sort matched by absolute variance DESC (largest discrepancies first).
  matched.sort((a, b) => Math.abs(b.variance ?? 0) - Math.abs(a.variance ?? 0));

  // Sort unmatched BOQ items by amount DESC.
  unmatchedBOQ.sort((a, b) => b.numeric_value - a.numeric_value);
  vendorOnlyScopes.sort((a, b) => (b.vendorTotal ?? 0) - (a.vendorTotal ?? 0));

  // ── Totals ───────────────────────────────────────────────────────────────────

  const boqGrandTotal    = boqQ.rows.reduce((s, r) => s + r.numeric_value, 0);
  const vendorGrandTotal = [...vendorByScope.values()].reduce((s, v) => s + v, 0);
  const grandVariance    = boqGrandTotal - vendorGrandTotal;
  const grandVariancePct = boqGrandTotal > 0 ? (grandVariance / boqGrandTotal) * 100 : 0;

  // ── Key inconsistencies summary ───────────────────────────────────────────────

  const inconsistencies: string[] = [];
  if (matched.length > 0) {
    const top = matched[0];
    inconsistencies.push(
      `Largest matched variance: "${top.scope}" — BOQ ${top.boqTotal?.toLocaleString()} SAR vs Vendor ${top.vendorTotal?.toLocaleString()} SAR (${top.variancePct?.toFixed(1)}% gap).`,
    );
  }
  if (unmatchedBOQ.length > 0) {
    const total = unmatchedBOQ.reduce((s, r) => s + r.numeric_value, 0);
    inconsistencies.push(
      `${unmatchedBOQ.length} BOQ items (total ${total.toLocaleString()} SAR) have no matching vendor entry.`,
    );
  }
  if (vendorOnlyScopes.length > 0) {
    const total = vendorOnlyScopes.reduce((s, r) => s + (r.vendorTotal ?? 0), 0);
    inconsistencies.push(
      `${vendorOnlyScopes.length} vendor scopes (total ${total.toLocaleString()} SAR) have no matching BOQ item.`,
    );
  }

  return {
    success: true,
    data: {
      summary: {
        boqGrandTotal,
        vendorGrandTotal,
        grandVariance,
        grandVariancePct: Math.round(grandVariancePct * 10) / 10,
        matchedScopes:    matched.length,
        boqOnlyItems:     unmatchedBOQ.length,
        vendorOnlyScopes: vendorOnlyScopes.length,
      },
      inconsistencies,
      // Matched pairs — sorted by variance (largest discrepancy first)
      matchedComparisons: matched.map(c => ({
        scope:       c.scope,
        boqItems:    c.boqLabels,
        boqTotal:    c.boqTotal,
        vendorTotal: c.vendorTotal,
        variance:    c.variance,
        variancePct: c.variancePct,
      })),
      // BOQ items with no vendor match
      unmatchedBOQItems: unmatchedBOQ.map(r => ({
        label:        r.label,
        amount:       r.numeric_value,
        boqSection:   r.section_title,
      })),
      // Vendor entries with no BOQ match
      vendorOnlyEntries: vendorOnlyScopes.map(c => ({
        scope:       c.scope,
        vendorTotal: c.vendorTotal,
      })),
    },
    sources: [
      { documentName: boqDocName,    location: 'Line items', excerpt: `${boqQ.rows.length} items, total: ${boqGrandTotal.toLocaleString()} SAR` },
      { documentName: vendorDocName, location: 'Vendor scopes', excerpt: `${vendorByScope.size} scopes, total: ${vendorGrandTotal.toLocaleString()} SAR` },
    ],
  };
}
