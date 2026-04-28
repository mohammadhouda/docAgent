import OpenAI from 'openai';
import { ToolResult } from '../types/index.js';
import { searchDocuments }      from './searchDocuments.js';
import { extractCostItems }     from './extractCostItems.js';
import { extractDatesDeliverables } from './extractDates.js';
import { summarizeDocument }    from './summarizeDocument.js';
import { listDocuments }        from './listDocuments.js';
import { compareCosts }         from './compareCosts.js';
import { calculateCostSummary } from './calculateCostSummary.js';
import { extractQuantities }    from './extractQuantities.js';
import { extractParties }       from './extractParties.js';
import { extractPercentages }   from './extractPercentages.js';
import { getDocumentSections }  from './getDocumentSections.js';

export const toolDefinitions: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_documents',
      description:
        'List all currently loaded documents with their IDs, types, metadata (project name, ' +
        'document type, currency, parties), and chunk counts. ' +
        'ALWAYS call this first on any new conversation to understand what files are available ' +
        'before calling other tools.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_documents',
      description:
        'Semantically search across all loaded documents for content relevant to a query. ' +
        'Use this for general questions about document content, clauses, terms, and narrative text. ' +
        'Prefers embedding-based similarity search; falls back to keyword search when embeddings are unavailable.',
      parameters: {
        type: 'object',
        properties: {
          query:      { type: 'string', description: 'Natural-language search query' },
          maxResults: { type: 'number', description: 'Max results to return (default 8)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_document_sections',
      description:
        'Discover the internal structure of loaded documents: sheet names, their item counts, ' +
        'cost totals per sheet, and item-code letter prefixes (A, B, M, E…) for single-sheet BOQs. ' +
        'Call this when the user asks "what sections are in this BOQ?", "what trades does this file cover?", ' +
        'or before filtering by category to know which keyword to use.',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Document ID from list_documents. Omit to inspect all documents.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_cost_items',
      description:
        'Extract individual line-item costs from a BOQ or cost document. ' +
        'Returns item codes, descriptions, and amounts ordered by value. ' +
        'Use for questions like "list items above X SAR", "most expensive items", or "list all MEP items". ' +
        'Always pass a documentId from list_documents.',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Document ID from list_documents (required)' },
          minAmount:  { type: 'number', description: 'Minimum amount to include (default 0)' },
          maxAmount:  { type: 'number', description: 'Maximum amount to include (no default)' },
          category:   { type: 'string', description: 'Trade or section keyword to filter by (e.g. "MEP", "civil", "electrical"). Matches sheet name or item description.' },
          currency:   { type: 'string', description: 'Currency code (default SAR)' },
        },
        required: ['documentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate_cost_summary',
      description:
        'Group and sum costs by section or trade to get a cost breakdown. ' +
        'Use for questions like "total cost per section", "breakdown by trade", "MEP budget", or "what is the total project cost". ' +
        'Pass category to filter by trade name (e.g. "MEP", "civil", "HVAC") — matches both sheet names and item descriptions. ' +
        'Returns a grand total and per-section totals.',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Document ID from list_documents. Omit to summarise across all documents.' },
          category:   { type: 'string', description: 'Trade or section keyword to filter by (e.g. "MEP", "civil works", "HVAC", "electrical"). Matches sheet name or item description.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_costs',
      description:
        'Compare costs across multiple uploaded documents side by side. ' +
        'Use when the user has multiple BOQs or bids and asks "which is cheaper", "compare costs", or "how do these differ". ' +
        'Optionally filter by a category keyword (e.g. "MEP", "HVAC", "civil").',
      parameters: {
        type: 'object',
        properties: {
          category:    { type: 'string',               description: 'Optional keyword to filter by (e.g. "HVAC", "civil works")' },
          documentIds: { type: 'array', items: { type: 'string' }, description: 'Limit comparison to these document IDs from list_documents' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_dates_deliverables',
      description:
        'Extract dates, deadlines, milestones, and schedule events from documents. ' +
        'Use for questions about timelines, submission deadlines, or project schedule.',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Document ID from list_documents. Omit to search all documents.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_quantities',
      description:
        'Extract measured quantities (volumes, areas, counts, weights) from BOQ documents. ' +
        'Use for questions like "total concrete volume", "how many elevators", or "what quantity of steel". ' +
        'Can filter by unit (m², m³, ton, etc.) and minimum value.',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Document ID from list_documents' },
          unit:       { type: 'string', description: 'Filter by unit of measure (e.g. "m3", "ton", "m2")' },
          minValue:   { type: 'number', description: 'Minimum quantity value to include' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_parties',
      description:
        'Extract named parties (contractors, clients, subcontractors, consultants) from documents. ' +
        'Use for questions like "who is the main contractor", "list all subcontractors", or "who is the employer".',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Document ID from list_documents' },
          role:       { type: 'string', description: 'Filter by role keyword (e.g. "contractor", "client", "consultant")' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_percentages',
      description:
        'Extract percentage values such as VAT, retention, markup, margin, and discount rates from documents. ' +
        'Use for questions about rates, percentages, or financial ratios.',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Document ID from list_documents' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'summarize_document',
      description:
        'Get a structured excerpt from a specific document (beginning, middle, end) ' +
        'for summarization or scope-of-work questions. Requires a documentId.',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Document ID or partial file name to summarize' },
        },
        required: ['documentId'],
      },
    },
  },
];

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'list_documents':
      return await listDocuments();
    case 'get_document_sections':
      return await getDocumentSections(args as { documentId?: string });
    case 'search_documents':
      return await searchDocuments(args as { query: string; maxResults?: number });
    case 'extract_cost_items':
      return await extractCostItems(args as { minAmount?: number; maxAmount?: number; category?: string; currency?: string; documentId?: string });
    case 'calculate_cost_summary':
      return await calculateCostSummary(args as { documentId?: string; category?: string });
    case 'compare_costs':
      return await compareCosts(args as { category?: string; documentIds?: string[] });
    case 'extract_dates_deliverables':
      return await extractDatesDeliverables(args as { documentId?: string });
    case 'extract_quantities':
      return await extractQuantities(args as { documentId?: string; unit?: string; minValue?: number });
    case 'extract_parties':
      return await extractParties(args as { documentId?: string; role?: string });
    case 'extract_percentages':
      return await extractPercentages(args as { documentId?: string });
    case 'summarize_document':
      return await summarizeDocument(args as { documentId: string });
    default:
      return { success: false, data: `Unknown tool: ${name}`, sources: [] };
  }
}
