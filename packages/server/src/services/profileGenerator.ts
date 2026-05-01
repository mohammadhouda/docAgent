import { pool } from '../db/client.js';
import { openaiClient } from './openai.js';
import { DocumentMetadata, DocumentProfile, SheetProfile } from '../types/index.js';

// ─── Stats computed purely from the DB (no LLM cost) ─────────────────────────

interface DocumentStats {
  availableValueTypes: string[];
  totalCost:           number | null;
  currency:            string | null;
  sheets:              SheetProfile[];
  sampleLabels:        string[];
  codePrefixes:        string[];
}

async function computeStats(documentId: string): Promise<DocumentStats> {
  const [typesRes, costRes, sheetsRes, labelsRes, prefixRes] = await Promise.all([
    pool.query<{ type: string }>(
      `SELECT DISTINCT type FROM extracted_values WHERE document_id = $1 ORDER BY type`,
      [documentId],
    ),
    pool.query<{ total: number | null; currency: string | null }>(
      `SELECT SUM(ev.numeric_value)::float AS total, MAX(ev.unit) AS currency
       FROM extracted_values ev
       WHERE ev.document_id = $1
         AND ev.type = 'cost'
         AND ev.numeric_value IS NOT NULL
         AND LOWER(COALESCE(ev.sheet_name, '')) NOT SIMILAR TO '%(summary|rollup|consolidated)%'`,
      [documentId],
    ),
    pool.query<{
      sheet_name: string;
      item_count: number;
      cost_total: number | null;
      currency:   string | null;
      value_types: string[];
      is_summary: boolean;
    }>(
      `SELECT
         ev.sheet_name,
         COUNT(*)::int                                                         AS item_count,
         SUM(CASE WHEN ev.type = 'cost' THEN ev.numeric_value END)::float     AS cost_total,
         MAX(CASE WHEN ev.type = 'cost' THEN ev.unit END)                     AS currency,
         array_agg(DISTINCT ev.type)                                           AS value_types,
         (LOWER(ev.sheet_name) SIMILAR TO '%(summary|rollup|consolidated)%')  AS is_summary
       FROM extracted_values ev
       WHERE ev.document_id = $1 AND ev.sheet_name IS NOT NULL
       GROUP BY ev.sheet_name
       ORDER BY cost_total DESC NULLS LAST`,
      [documentId],
    ),
    pool.query<{ label: string }>(
      `SELECT label
       FROM extracted_values
       WHERE document_id = $1 AND type = 'cost' AND numeric_value IS NOT NULL
       ORDER BY numeric_value DESC NULLS LAST
       LIMIT 20`,
      [documentId],
    ),
    pool.query<{ prefix: string; cnt: number }>(
      `SELECT UPPER(REGEXP_REPLACE(label, '^([A-Za-z]+)[-.].*', '\\1')) AS prefix,
              COUNT(*)::int AS cnt
       FROM extracted_values
       WHERE document_id = $1 AND type = 'cost' AND label ~ '^[A-Za-z]+[-.]'
       GROUP BY prefix
       ORDER BY cnt DESC
       LIMIT 8`,
      [documentId],
    ),
  ]);

  const sheets: SheetProfile[] = sheetsRes.rows.map((r) => ({
    name:               r.sheet_name,
    role:               r.is_summary ? 'summary' : 'line-items',
    itemCount:          r.item_count,
    costTotal:          r.cost_total ?? undefined,
    currency:           r.currency   ?? undefined,
    dominantValueTypes: Array.isArray(r.value_types) ? r.value_types : [],
  }));

  return {
    availableValueTypes: typesRes.rows.map((r) => r.type),
    totalCost:           costRes.rows[0]?.total   ?? null,
    currency:            costRes.rows[0]?.currency ?? null,
    sheets,
    sampleLabels:        labelsRes.rows.map((r) => r.label),
    codePrefixes:        prefixRes.rows.map((r) => r.prefix),
  };
}

// ─── LLM classification (1 call per ingestion) ────────────────────────────────

interface LLMClassification {
  documentType: DocumentProfile['documentType'];
  summary:      string;
  language:     string;
  keyCategories: string[];
  queryHints:   string[];
}

async function classifyWithLLM(
  fileName:  string,
  metadata:  DocumentMetadata,
  stats:     DocumentStats,
): Promise<LLMClassification> {
  const sheetLines = stats.sheets.map((s) => {
    const cost = s.costTotal
      ? ` · ${s.costTotal.toLocaleString()} ${s.currency ?? ''}`
      : '';
    return `  - "${s.name}" [${s.role}, ${s.itemCount} items${cost}]`;
  }).join('\n');

  const prompt = `You are classifying a project document to help an AI agent query it correctly.

File name: "${fileName}"
Preliminary type: "${metadata.type ?? 'unknown'}"
Preliminary summary: "${metadata.summary ?? 'none'}"
Value types found: ${stats.availableValueTypes.join(', ') || 'none'}
Code prefixes in item labels: ${stats.codePrefixes.join(', ') || 'none'}
Sheets / sections:
${sheetLines || '  (no sheet data — possibly a PDF or flat document)'}
Top 20 cost item labels:
${stats.sampleLabels.slice(0, 20).map((l) => `  - ${l}`).join('\n') || '  (none)'}

Return a JSON object:
{
  "documentType": one of "boq" | "programme" | "contract" | "cost-report" | "risk-register" | "specification" | "procurement" | "other",
  "summary": "2 sentences: what this document is and what it contains",
  "language": "ISO 639-1 code, e.g. en / ar / fr",
  "keyCategories": ["up to 8 major sections, trades, or categories present in the document"],
  "queryHints": ["2 to 5 practical tips for how to query this document — mention specific category keywords, code prefixes, sheet names, or tool choices that will work well"]
}`;

  try {
    const res = await openaiClient.chat.completions.create({
      model:           'gpt-5.4-mini',
      temperature:     0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You classify project documents and return structured JSON metadata.' },
        { role: 'user',   content: prompt },
      ],
    });

    const raw = JSON.parse(res.choices[0]?.message?.content ?? '{}');
    return {
      documentType:  raw.documentType  ?? 'other',
      summary:       typeof raw.summary === 'string' ? raw.summary : (metadata.summary ?? ''),
      language:      typeof raw.language === 'string' ? raw.language : 'en',
      keyCategories: Array.isArray(raw.keyCategories) ? raw.keyCategories.slice(0, 8) : [],
      queryHints:    Array.isArray(raw.queryHints)   ? raw.queryHints.slice(0, 5)    : [],
    };
  } catch {
    return {
      documentType:  (metadata.type as DocumentProfile['documentType']) ?? 'other',
      summary:       metadata.summary ?? '',
      language:      'en',
      keyCategories: [],
      queryHints:    [],
    };
  }
}

// ─── Tool suggestion (derived, no LLM) ───────────────────────────────────────

function deriveSuggestedTools(
  documentType: DocumentProfile['documentType'],
  availableTypes: string[],
): string[] {
  const tools = new Set<string>();

  if (availableTypes.includes('cost')) {
    tools.add('calculate_cost_summary');
    tools.add('extract_cost_items');
  }
  if (availableTypes.includes('quantity')) {
    tools.add('extract_quantities');
    tools.add('calculate_unit_rate');
  }
  if (availableTypes.includes('date')) {
    tools.add('extract_dates_deliverables');
  }
  if (availableTypes.includes('party')) {
    tools.add('extract_parties');
  }
  if (availableTypes.includes('percentage')) {
    tools.add('extract_percentages');
  }

  switch (documentType) {
    case 'boq':
      tools.add('calculate_cost_summary');
      tools.add('extract_cost_items');
      tools.add('calculate_percentage_of_total');
      tools.add('compare_costs');
      break;
    case 'programme':
      tools.add('query_schedule_by_status');
      tools.add('extract_dates_deliverables');
      break;
    case 'contract':
      tools.add('extract_parties');
      tools.add('extract_percentages');
      tools.add('search_documents');
      break;
    case 'cost-report':
      tools.add('query_budget_variance');
      tools.add('calculate_cost_summary');
      break;
    case 'specification':
    case 'other':
      tools.add('search_documents');
      tools.add('summarize_document');
      break;
  }

  return Array.from(tools).slice(0, 6);
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function generateDocumentProfile(
  documentId: string,
  fileName:   string,
  metadata:   DocumentMetadata,
): Promise<DocumentProfile> {
  const stats  = await computeStats(documentId);
  const llm    = await classifyWithLLM(fileName, metadata, stats);

  return {
    documentType:        llm.documentType,
    summary:             llm.summary,
    language:            llm.language,
    currency:            stats.currency ?? metadata.currency ?? 'SAR',
    keyCategories:       llm.keyCategories,
    availableValueTypes: stats.availableValueTypes,
    totalCost:           stats.totalCost ?? undefined,
    sheets:              stats.sheets.length > 0 ? stats.sheets : undefined,
    suggestedTools:      deriveSuggestedTools(llm.documentType, stats.availableValueTypes),
    queryHints:          llm.queryHints,
  };
}
