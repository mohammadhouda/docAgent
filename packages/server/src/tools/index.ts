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
import { getDocumentSections }        from './getDocumentSections.js';
import { calculatePercentageOfTotal } from './calculatePercentageOfTotal.js';
import { calculateCostVariance }      from './calculateCostVariance.js';
import { calculateUnitRate }          from './calculateUnitRate.js';
import { computeDifference }          from './computeDifference.js';
import { computeSum }                 from './computeSum.js';
import { queryScheduleByStatus }      from './queryScheduleByStatus.js';
import { queryBudgetVariance }        from './queryBudgetVariance.js';
import { applyPercentage }            from './applyPercentage.js';

export const toolDefinitions: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_documents',
      description:
        'Answer "what files are loaded?" or "what documents do you have?". ' +
        'Returns each document\'s ID, type, project metadata, and sheet/page counts. ' +
        'ALWAYS call this once at the start of a new conversation — the document IDs returned here ' +
        'are required by every other tool. Skip if IDs are already in the conversation history.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_documents',
      description:
        'Answer questions about document content when no structured tool fits — contract clauses, ' +
        'scope descriptions, narrative text, specifications, or vague cross-document questions. ' +
        'Uses semantic similarity when embeddings are available; falls back to keyword search.',
      parameters: {
        type: 'object',
        properties: {
          query:      { type: 'string', description: 'Natural-language question or search phrase' },
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
        'Answer "what sections / trades are in this BOQ?" or "what sheets does this file have?". ' +
        'Also call this before filtering by category when you are unsure which keyword to use — ' +
        'it shows sheet names, item counts, cost totals per sheet, and item-code letter prefixes ' +
        '(A, B, M, E…) for single-sheet BOQs.',
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
        'Answer "what are the most expensive items?", "list all electrical line items", or ' +
        '"show items above 100,000 SAR". Returns individual BOQ line items ordered by value ' +
        '(descending — first item = most expensive). ' +
        'Always pass documentId from list_documents. Use category to narrow by trade or section; ' +
        'similar terms like "electrical", "elec", and "ELC" are automatically matched via embeddings.',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Document ID from list_documents (required)' },
          minAmount:  { type: 'number', description: 'Minimum amount to include (default 0)' },
          maxAmount:  { type: 'number', description: 'Maximum amount to include' },
          category:   { type: 'string', description: 'Trade or section to filter by (e.g. "electrical", "ELC", "civil", "MEP"). Matched semantically — abbreviations and alternate spellings are resolved automatically.' },
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
        'Answer "what is the total cost?", "break down the cost by trade", "what is the civil section budget?", ' +
        'or "which section costs most?". Groups costs by sheet/section and returns a grand total plus ' +
        'per-section subtotals ordered descending (first = highest). ' +
        'Pass category to filter by trade — similar terms like "electrical", "elec", and "ELC" are ' +
        'resolved automatically via embeddings.',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Document ID from list_documents. Omit to summarise across all documents.' },
          category:   { type: 'string', description: 'Trade or section to filter by (e.g. "MEP", "civil works", "electrical", "ELC"). Matched semantically.' },
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
        'Answer "which bid is cheaper?", "compare these two quotes", or "show me costs side by side". ' +
        'Returns totals for each document ordered descending (first = highest) plus a line-item breakdown. ' +
        'Use calculate_cost_variance instead when you need a focused A-vs-B difference with a percentage.',
      parameters: {
        type: 'object',
        properties: {
          category:    { type: 'string',               description: 'Trade or section keyword to filter by (e.g. "HVAC", "civil works"). Matched semantically.' },
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
        'Answer "what are the key dates?", "when is the submission deadline?", or ' +
        '"list all milestones". Extracts dates, deadlines, and schedule events from documents.',
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
        'Answer "what is the total concrete volume?", "how many elevators?", or ' +
        '"what quantity of steel?". Extracts measured quantities from BOQ documents. ' +
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
        'Answer "who is the main contractor?", "list all subcontractors", or "who is the employer?". ' +
        'Extracts named parties (contractors, clients, subcontractors, consultants) from documents.',
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
        'Answer "what is the VAT rate?", "what is the retention percentage?", or ' +
        '"what markup applies?". Extracts percentage values such as VAT, retention, markup, and discount rates.',
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
      name: 'apply_percentage',
      description:
        'Answer "what is the VAT-inclusive total?", "contract value after retention deduction", or ' +
        '"total with markup". Apply a percentage rate to a base amount from tool output. ' +
        'Use "add" for VAT-inclusive totals or markup; "subtract" for retention or discount deductions. ' +
        'NEVER compute this yourself — always call this tool when you have a base amount and a rate.',
      parameters: {
        type: 'object',
        properties: {
          baseAmount:  { type: 'number', description: 'The base monetary amount' },
          rate:        { type: 'number', description: 'The percentage rate to apply (e.g. 15 for 15% VAT)' },
          operation:   { type: 'string', enum: ['add', 'subtract'], description: '"add" to include the rate (VAT, markup), "subtract" to remove it (retention, discount). Default: add' },
          labelBase:   { type: 'string', description: 'Human-readable label for the base amount (e.g. "Contract value ex-VAT")' },
          labelRate:   { type: 'string', description: 'Human-readable label for the rate (e.g. "VAT", "Retention", "Markup")' },
        },
        required: ['baseAmount', 'rate'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compute_difference',
      description:
        'Answer "what is the difference between X and Y?", "by how much is A higher than B?", or ' +
        '"what percentage gap is there?". Computes the exact arithmetic difference between two numeric ' +
        'values already retrieved from tool output. ' +
        'NEVER subtract numbers yourself — always call this tool.',
      parameters: {
        type: 'object',
        properties: {
          valueA: { type: 'number', description: 'First value' },
          labelA: { type: 'string', description: 'Label for first value (e.g. document or project name)' },
          valueB: { type: 'number', description: 'Second value' },
          labelB: { type: 'string', description: 'Label for second value' },
        },
        required: ['valueA', 'valueB'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate_percentage_of_total',
      description:
        'Answer "what share of the budget is MEP?", "what percentage is civil works?", or ' +
        '"what fraction of total cost is electrical?". Returns category total, grand total, and ' +
        'the exact percentage — do NOT compute this yourself. ' +
        'Category is matched semantically, so "ELC", "elec", and "electrical" all resolve correctly.',
      parameters: {
        type: 'object',
        properties: {
          category:   { type: 'string', description: 'Trade or section keyword (e.g. "MEP", "civil", "electrical", "ELC"). Matched semantically via embeddings.' },
          documentId: { type: 'string', description: 'Document ID from list_documents. Omit to calculate across all documents.' },
        },
        required: ['category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate_cost_variance',
      description:
        'Answer "how much more expensive is bid A than bid B?", "what is the cost difference?", or ' +
        '"which bid is cheaper and by how much?". Returns both document totals, the absolute difference, ' +
        'and the percentage difference — all pre-computed.',
      parameters: {
        type: 'object',
        properties: {
          documentIdA: { type: 'string', description: 'First document ID (from list_documents)' },
          documentIdB: { type: 'string', description: 'Second document ID (from list_documents)' },
          category:    { type: 'string', description: 'Optional trade/section keyword to limit the comparison (e.g. "MEP", "civil"). Matched semantically.' },
        },
        required: ['documentIdA', 'documentIdB'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate_unit_rate',
      description:
        'Answer "what is the rate per m³ for piling?", "cost per m² for the slab", or ' +
        '"what is the unit rate for reinforcement?". Divides the cost column by the quantity column ' +
        'on the same BOQ row. Requires a BOQ with both cost and quantity columns. ' +
        'Do NOT divide these yourself.',
      parameters: {
        type: 'object',
        properties: {
          item:       { type: 'string', description: 'Item description keyword to search for (e.g. "piling", "concrete", "reinforcement")' },
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
        'Answer "summarize this document" or "what is the scope of work?". Samples the beginning, ' +
        'middle, and end of a document to give a broad overview. Requires a documentId from list_documents.',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Document ID or partial file name to summarize' },
        },
        required: ['documentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compute_sum',
      description:
        'Answer "what is the total?", "what is the combined value?", or "sum these amounts". ' +
        'Adds up an array of numeric values — use this when you have multiple values from tool outputs ' +
        'and need their total. NEVER sum values yourself; always call this tool. ' +
        'Returns the total, count of items, and optionally a breakdown with labels.',
      parameters: {
        type: 'object',
        properties: {
          values: { type: 'array', items: { type: 'number' }, description: 'Array of numeric values to sum' },
          label:  { type: 'string', description: 'Label for the total (e.g. "Combined Contract Value", "Total MEP Cost")' },
          items:  { type: 'array', items: { type: 'string' }, description: 'Optional labels for each value (e.g. vendor names, item descriptions) for traceability' },
        },
        required: ['values'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_schedule_by_status',
      description:
        'Answer "which tasks are in progress?", "what is completed?", or "show me not started activities". ' +
        'Query project schedule/programme documents to find tasks matching a specific status. ' +
        'Returns task ID, description, responsible party, start/end dates, and status. ' +
        'Requires a documentId from list_documents.',
      parameters: {
        type: 'object',
        properties: {
          status:     { type: 'string', description: 'Status to filter by (e.g. "In Progress", "Completed", "Not Started")' },
          documentId: { type: 'string', description: 'Document ID from list_documents (required)' },
        },
        required: ['status', 'documentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_budget_variance',
      description:
        'Answer "what is the budget vs actual?", "which categories are over budget?", or "what is the project cost position?". ' +
        'Query cost tracking documents to compare budget vs actual spending. ' +
        'Returns total budget, total actual spend, variance, and per-category breakdown with over-budget items flagged. ' +
        'Requires a documentId from list_documents.',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'Document ID from list_documents (required)' },
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
    case 'apply_percentage':
      return await applyPercentage(args as { baseAmount: number; rate: number; operation?: 'add' | 'subtract'; labelBase?: string; labelRate?: string });
    case 'compute_difference':
      return await computeDifference(args as { valueA: number; labelA?: string; valueB: number; labelB?: string });
    case 'compute_sum':
      return await computeSum(args as { values: number[]; label?: string; items?: string[] });
    case 'query_schedule_by_status':
      return await queryScheduleByStatus(args as { status: string; documentId?: string });
    case 'query_budget_variance':
      return await queryBudgetVariance(args as { documentId?: string });
    case 'calculate_percentage_of_total':
      return await calculatePercentageOfTotal(args as { category: string; documentId?: string });
    case 'calculate_cost_variance':
      return await calculateCostVariance(args as { documentIdA: string; documentIdB: string; category?: string });
    case 'calculate_unit_rate':
      return await calculateUnitRate(args as { item?: string; documentId?: string });
    case 'summarize_document':
      return await summarizeDocument(args as { documentId: string });
    default:
      return { success: false, data: `Unknown tool: ${name}`, sources: [] };
  }
}
