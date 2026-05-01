import OpenAI from 'openai';
import { ToolResult } from '../types/index.js';
import { searchDocuments }  from './searchDocuments.js';
import { queryValues }      from './queryValues.js';
import { aggregateValues }  from './aggregateValues.js';
import { computeResult }    from './computeResult.js';
import { getDocumentInfo }  from './getDocumentInfo.js';

export const toolDefinitions: OpenAI.Chat.ChatCompletionTool[] = [
  // ── 1. Document Info ──────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_document_info',
      description:
        'Three modes in one tool:\n' +
        '  "list"      — list all loaded documents with IDs, types, and metadata. ' +
        'Call ONCE at the start of each new conversation before any other tool. ' +
        'The IDs returned here are required by every other tool.\n' +
        '  "sections"  — show sheet/section breakdown: item counts, cost totals per sheet, ' +
        'and code-letter prefixes (A, B, M, E…) for single-sheet BOQs. ' +
        'Call this before using a category filter if you are unsure which keyword to use.\n' +
        '  "summarize" — sample beginning, middle, and end of a document for a broad overview. ' +
        'Requires documentId.',
      parameters: {
        type: 'object',
        properties: {
          mode:       { type: 'string', enum: ['list', 'sections', 'summarize'], description: 'What to retrieve' },
          documentId: { type: 'string', description: 'Document ID from "list" mode. Required for "summarize"; optional for "sections".' },
        },
        required: ['mode'],
      },
    },
  },

  // ── 2. Semantic / keyword search ─────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'search_documents',
      description:
        'Answer questions about document content when no structured tool fits — ' +
        'contract clauses, scope descriptions, narrative text, specifications, ' +
        'or vague cross-document questions. ' +
        'Uses semantic similarity when embeddings are available; falls back to keyword search.',
      parameters: {
        type: 'object',
        properties: {
          query:      { type: 'string', description: 'Natural-language question or search phrase' },
          maxResults: { type: 'number', description: 'Max results (default 8)' },
        },
        required: ['query'],
      },
    },
  },

  // ── 3. Structured value retrieval ─────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'query_values',
      description:
        'Retrieve individual extracted data points from any document type.\n' +
        'Standard types: cost, quantity, date, percentage, party, reference, duration.\n' +
        'Custom types (programme/schedule): status, risk_level, completion_rate.\n\n' +
        'Use cases:\n' +
        '  "list all MEP line items" → types:["cost"], category:"MEP"\n' +
        '  "what quantities of concrete?" → types:["quantity"], unit:"m3"\n' +
        '  "key dates and milestones" → types:["date"]\n' +
        '  "who are the parties?" → types:["party"]\n' +
        '  "items above 500k SAR" → types:["cost"], minValue:500000\n' +
        '  "in-progress activities" → types:["status"], rawValueFilter:"In Progress"\n' +
        '  "high likelihood risks" → types:["likelihood"], rawValueFilter:"High"\n\n' +
        'category is matched semantically — "MEP", "mep", "mechanical" all resolve correctly.',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Document ID (from get_document_info list). Omit to search all documents.' },
          types:      { type: 'array', items: { type: 'string' }, description: 'One or more value types to retrieve (required)' },
          category:   { type: 'string', description: 'Trade/section keyword filter (e.g. "MEP", "civil", "ELC"). Matched semantically via embeddings.' },
          minValue:   { type: 'number', description: 'Minimum numeric value' },
          maxValue:   { type: 'number', description: 'Maximum numeric value' },
          unit:       { type: 'string', description: 'Filter by unit of measure (e.g. "m3", "ton", "m2")' },
          rawValueFilter: { type: 'string', description: 'Filter by raw_value text match for ANY categorical column — use for status values ("In Progress"), likelihood levels ("High"), ratings ("Low"), or any other enum-style field.' },
          limit:      { type: 'number', description: 'Max rows to return (default 150)' },
          orderBy:    { type: 'string', enum: ['value_desc', 'value_asc', 'date_asc', 'label'], description: 'Sort order (default value_desc)' },
        },
        required: ['types'],
      },
    },
  },

  // ── 4. Aggregation ────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'aggregate_values',
      description:
        'Compute aggregated statistics over extracted values — replaces cost summary, cost comparison, ' +
        'variance, percentage-of-total, and budget-variance tools.\n\n' +
        'Use cases:\n' +
        '  "total MEP budget" → type:"cost", groupBy:"section", category:"MEP", aggregation:"sum"\n' +
        '  "cost breakdown by trade" → type:"cost", groupBy:"category"\n' +
        '  "compare costs across documents" → type:"cost", groupBy:"document"\n' +
        '  "average unit rates" → type:"cost", groupBy:"sheet", aggregation:"avg"\n' +
        '  "budget vs actual" → call twice: type:"budget" then type:"actual", then compute_result difference\n' +
        '  "which sheet costs most?" → type:"cost", groupBy:"sheet" (result is ordered desc)\n\n' +
        'Always pass category when the question is about a specific trade or section. ' +
        'The response includes an interpretation field that tells you what the total represents.',
      parameters: {
        type: 'object',
        properties: {
          documentId:            { type: 'string', description: 'Document ID. Omit to aggregate across all documents.' },
          type:                  { type: 'string', description: 'Value type to aggregate: "cost", "quantity", "budget", "actual", or any custom type.' },
          groupBy:               { type: 'string', enum: ['sheet', 'section', 'document', 'category', 'type'], description: 'Dimension to group by' },
          aggregation:           { type: 'string', enum: ['sum', 'count', 'avg', 'max', 'min'], description: 'Aggregation function (default: sum)' },
          category:              { type: 'string', description: 'Trade/section keyword to filter by before aggregating. Matched semantically.' },
          excludeSummarySheets:  { type: 'boolean', description: 'Exclude roll-up/summary sheets from aggregation to prevent double-counting line items (default true). Pass false only when explicitly querying summary-sheet totals.' },
        },
        required: ['type', 'groupBy'],
      },
    },
  },

  // ── 5. Arithmetic ─────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'compute_result',
      description:
        'All arithmetic in one tool — NEVER compute numbers yourself; always call this.\n\n' +
        'operations:\n' +
        '  "sum"        — add an array of values (use when you have multiple tool outputs to total)\n' +
        '  "difference" — A minus B with absolute difference and percentage gap\n' +
        '  "ratio"      — what percentage is "part" of "whole"? (e.g. MEP share of total budget)\n' +
        '  "apply_rate" — apply a percentage rate to a base: "add" for VAT/markup, "subtract" for retention/discount\n' +
        '  "unit_rate"  — DB lookup: cost ÷ quantity for BOQ rows that have both columns\n\n' +
        'For "sum": provide values[] and optional labels[].\n' +
        'For "difference": provide valueA and valueB.\n' +
        'For "ratio": provide part and whole.\n' +
        'For "apply_rate": provide baseAmount, rate, and direction ("add" or "subtract").\n' +
        'For "unit_rate": provide documentId and optional item keyword.',
      parameters: {
        type: 'object',
        properties: {
          operation:   { type: 'string', enum: ['sum', 'difference', 'ratio', 'apply_rate', 'unit_rate'], description: 'Which computation to perform' },
          // sum
          values:      { type: 'array', items: { type: 'number' }, description: '[sum] Array of values to add' },
          labels:      { type: 'array', items: { type: 'string' }, description: '[sum] Optional label for each value' },
          resultLabel: { type: 'string', description: '[sum] Label for the total' },
          // difference
          valueA:      { type: 'number', description: '[difference] First value (minuend)' },
          labelA:      { type: 'string',  description: '[difference] Label for first value' },
          valueB:      { type: 'number', description: '[difference] Second value (subtrahend)' },
          labelB:      { type: 'string',  description: '[difference] Label for second value' },
          // ratio
          part:        { type: 'number', description: '[ratio] The numerator (e.g. MEP cost)' },
          whole:       { type: 'number', description: '[ratio] The denominator (e.g. total budget)' },
          partLabel:   { type: 'string',  description: '[ratio] Label for part' },
          wholeLabel:  { type: 'string',  description: '[ratio] Label for whole' },
          // apply_rate
          baseAmount:  { type: 'number', description: '[apply_rate] The base monetary amount' },
          rate:        { type: 'number', description: '[apply_rate] Percentage rate (e.g. 15 for 15%)' },
          direction:   { type: 'string', enum: ['add', 'subtract'], description: '[apply_rate] "add" for VAT/markup, "subtract" for retention/discount' },
          labelBase:   { type: 'string',  description: '[apply_rate] Label for base amount' },
          labelRate:   { type: 'string',  description: '[apply_rate] Label for the rate' },
          // unit_rate
          documentId:  { type: 'string', description: '[unit_rate] Document ID from get_document_info' },
          item:        { type: 'string',  description: '[unit_rate] Item description keyword to search for' },
        },
        required: ['operation'],
      },
    },
  },
];

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'get_document_info':
      return await getDocumentInfo(args as { mode: 'list' | 'sections' | 'summarize'; documentId?: string });
    case 'search_documents':
      return await searchDocuments(args as { query: string; maxResults?: number });
    case 'query_values':
      return await queryValues(args as Parameters<typeof queryValues>[0]);
    case 'aggregate_values':
      return await aggregateValues(args as Parameters<typeof aggregateValues>[0]);
    case 'compute_result':
      return await computeResult(args as Parameters<typeof computeResult>[0]);
    default:
      return { success: false, data: `Unknown tool: ${name}`, sources: [] };
  }
}
