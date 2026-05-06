# How DocAgent Works

DocAgent is built around two core workflows:

1. **Document Ingestion** — transforming raw files into searchable, queryable intelligence
2. **Question Answering** — an AI agent that chooses the right tool for each question

Both run asynchronously via BullMQ + Redis, keeping the UI responsive while background workers handle heavy processing.

---

## 1. Document Ingestion Pipeline

When a file is uploaded, it enters a queue and flows through **7 stages**:

```
Upload → Parse → Chunk → Embed → Classify → Profile → Extract → Store
```

### Stage 1: Parse Content

The system reads the file using format-specific parsers:

#### PDF Files
- **Library:** `pdf-parse`
- **Method:** Page-by-page extraction with coordinate-based line reconstruction
- **Output:** Text content with page numbers and layout metadata
- **Limit:** 50 pages max (configurable)

#### Excel Files (`.xlsx`, `.xls`)
- **Library:** `exceljs`
- **Method:** Section-aware parsing
  - Detects header row (first row with ≥2 distinct non-empty cells)
  - Groups rows by section headers (bold rows, or rows with few cells)
  - Preserves sheet names and row ranges
- **Output:** Structured rows with sheet/section context

#### CSV Files
- **Method:** Single-sheet parsing with header detection
- **Output:** Same structure as Excel

---

### Stage 2: Smart Chunking

Large documents are split into searchable "chunks" optimized for semantic search:

| Content Type | Target Size | Overlap |
|---|---|---|
| Text (PDF) | ~800 tokens | 75 tokens (last paragraph) |
| Tables (PDF/Excel) | ~500 tokens | 75 tokens (last 2 rows) |

**Why chunking matters:**

Instead of searching an entire document, the system searches only relevant sections.

*Example:*
- Chunk 1: "Payment Terms — 30 days net"
- Chunk 2: "Scope of Work — MEP installation"
- Chunk 3: "BOQ Section A — Concrete Works"

Each chunk retains metadata:
- `documentId` — which file it came from
- `pageNumber` or `sheetName` — location within file
- `sectionTitle` — trade/section header (e.g., "MEP Works")
- `chunkType` — `text`, `table`, or `heading`

---

### Stage 3: Embeddings (Semantic Search)

Each chunk is converted into a **vector** — a 1,536-dimensional numerical representation of meaning.

**Model:** `text-embedding-3-small` (OpenAI)

**How it works:**
```
Text: "Payment due within 30 days"
  ↓
Embedding: [0.023, -0.145, 0.892, ...]  (1,536 dimensions)
  ↓
Stored in PostgreSQL with pgvector (HNSW index)
```

**Why embeddings matter:**

The system finds **meaning**, not just keyword matches.

*Example:*
- **User asks:** "What are the payment conditions?"
- **Document says:** "Terms of invoice settlement: 30 days net"
- **Result:** Match! Semantically similar despite different wording.

---

### Stage 4: Document Classification

`gpt-4o-mini` reads the first 2 chunks to extract metadata:

| Field | Example |
|---|---|
| `documentType` | "BOQ", "Contract", "Schedule", "Payment Register" |
| `projectName` | "Riyadh Business Tower" |
| `currency` | "SAR", "USD", "AED" |
| `parties` | ["Najd Construction", "Al-Faisal Holdings"] |
| `summary` | "Bill of quantities for Riyadh Tower Phase 1" |

This metadata is stored in the `meta_*` columns of the `documents` table.

---

### Stage 5: Document Profiling

A second AI pass (`gpt-5.4-mini`) generates a structured **profile** stored in the `profile` JSONB column:

```typescript
interface DocumentProfile {
  documentType:        "boq" | "programme" | "contract" | "cost-report" | "risk-register" | "specification" | "procurement" | "other";
  summary:             string;  // 2-sentence description
  language:            string;  // ISO 639-1 code
  currency:            string;  // SAR, USD, AED...
  keyCategories:       string[];  // up to 8 major sections/trades
  availableValueTypes: string[];  // cost, date, quantity, party, percentage, status...
  totalCost?:          number;   // sum of all cost values
  sheets?:             SheetProfile[];  // per-sheet breakdown
  suggestedTools:      string[];  // top 5 tools for this document
  queryHints:          string[];  // practical tips for querying
}
```

**Sheet Profile:**
```typescript
interface SheetProfile {
  name:               string;
  role:               "line-items" | "summary";
  itemCount:          number;
  costTotal?:         number;
  currency?:          string;
  dominantValueTypes: string[];
}
```

**Query Hints Example:**
```
[
  "Use category filter 'MEP' or 'mechanical' for HVAC/electrical/plumbing items",
  "Code prefixes M-, E-, P- indicate MEP trades",
  "Sheet 'Cost_Tracking' has budget vs actual data with variance columns",
  "Outstanding values are type 'outstanding', not 'cost'"
]
```

**Suggested Tools Example:**
```
["query_values", "aggregate_values", "compute_result", "get_document_info", "search_documents"]
```

---

### Stage 6: Structured Extraction

Beyond text search, the system extracts **specific values** into a structured SQL table.

#### Excel Extraction (Deterministic)

1. **LLM Schema Inference:** `gpt-5.4-mini` analyzes headers + sample rows to classify columns:
   - `label` — item description
   - `item_no` — sequential codes (e.g., "1.01", "CC-100")
   - `value` — extractable data (costs, dates, quantities)
   - `category` — grouping column (e.g., "Trade", "Section")

2. **Type Normalization:** Header keywords override LLM inference:
   | Header contains | Type assigned |
   |---|---|
   | "budget", "planned" | `budget` |
   | "actual", "paid", "spent" | `actual` |
   | "outstanding", "balance" | `outstanding` |
   | "variance", "difference" | `variance` |
   | "contract" | `contract_value` |

3. **Row Processing:** Each data row yields structured values:
   ```
   Row: CC-100 | Design & Consultancy | 1,850,000 | 1,920,000 | -70,000
   → Extracted:
      { type: 'budget', label: 'CC-100: Design', numericValue: 1850000 }
      { type: 'actual', label: 'CC-100: Design', numericValue: 1920000 }
      { type: 'variance', label: 'CC-100: Design', numericValue: -70000 }
   ```

#### PDF Extraction (LLM-driven)

- **Model:** `gpt-5.4-mini` per page (5 concurrent)
- **Extracts:** Costs, dates, quantities, parties, percentages, durations, statuses
- **Output:** Same `extracted_values` table as Excel

---

### Stage 7: Store in PostgreSQL

All data is persisted via Drizzle ORM:

| Table | Columns |
|---|---|
| `documents` | `id`, `file_name`, `file_type`, `profile` (JSONB), `meta_type`, `meta_project_name`, `meta_currency`, `meta_parties`, `meta_summary`, `total_pages`, `total_sheets`, `ingested_at` |
| `chunks` | `id`, `document_id`, `content`, `embedding` (vector), `page_number`, `sheet_name`, `section_title`, `chunk_type`, `row_start`, `row_end` |
| `extracted_values` | `id`, `document_id`, `type`, `label`, `raw_value`, `numeric_value`, `date_value`, `unit`, `context`, `sheet_name`, `section_title`, `row_number` |

**Cascade deletes:** Deleting a document automatically removes its chunks and extracted values.

---

## 2. Question Answering Flow

When a user asks a question:

```
POST /api/ask
    ↓
Enqueue job (BullMQ) → return 202 immediately
    ↓
Frontend polls /api/ask/jobs/:id every 1s
    ↓
Worker processes job (concurrency: 3)
    ↓
Agent loop runs (max 5 iterations)
    ↓
Return structured JSON answer
```

### Agent Architecture

**Model:** `gpt-4o-mini` with function calling

**Loop:**
1. System prompt includes loaded document inventory (from `profile` column)
2. Model chooses which tool to call based on question
3. Tool executes SQL query against PostgreSQL
4. Result returned to model
5. Repeat up to 5 times
6. Model synthesizes final answer as structured JSON

**Key design:** The agent **never does arithmetic**. All calculations go through tools.

---

## The 5 Core Tools

The system uses **5 flexible tools** that cover all question types through parameters:

### 1. `get_document_info`

**Modes:**
- `list` — all loaded documents with IDs, types, profile summaries
- `sections` — sheet/section breakdown for a document
- `summarize` — AI summary of document content

**Example questions:**
- "What files do you have?"
- "What sections are in this BOQ?"
- "Summarize this contract"

---

### 2. `search_documents`

Semantic search via pgvector cosine similarity.

**Example questions:**
- "What are the payment terms?"
- "Show me scope of work clauses"
- "What does the spec say about concrete strength?"

---

### 3. `query_values`

Retrieve filtered extracted values.

**Parameters:**
- `types` — cost, quantity, date, percentage, party, status, duration, reference, outstanding, budget, actual, variance
- `category` — trade/section filter (semantic matching)
- `minValue` / `maxValue` — numeric range
- `unit` — filter by unit (m³, ton, m²)
- `rawValueFilter` — filter categorical fields (e.g., "In Progress", "High")
- `orderBy` — value_desc, value_asc, date_asc, label
- `limit` — max rows (default 150)

**Example questions:**
- "List all MEP line items" → `types: ["cost"], category: "MEP"`
- "What quantities of concrete?" → `types: ["quantity"], unit: "m3"`
- "Items above 500k SAR" → `types: ["cost"], minValue: 500000`
- "In-progress activities" → `types: ["status"], rawValueFilter: "In Progress"`
- "Total outstanding owed" → `types: ["outstanding"]`

---

### 4. `aggregate_values`

Compute aggregated statistics.

**Parameters:**
- `type` — budget, actual, cost, outstanding, variance, quantity, percentage
- `groupBy` — sheet, section, document, category, type
- `aggregation` — sum, count, avg, max, min
- `category` — trade/section filter (semantic matching)
- `excludeSummarySheets` — prevent double-counting (default true)

**Example questions:**
- "Total MEP budget" → `type: "cost", groupBy: "section", category: "MEP"`
- "Budget vs actual" → call twice: `type: "budget"` then `type: "actual"`
- "Which category costs most?" → `type: "cost", groupBy: "category"`
- "Total outstanding" → `type: "outstanding", groupBy: "document"`
- "Over budget categories" → compare budget vs actual results

---

### 5. `compute_result`

All arithmetic operations.

**Operations:**
- `sum` — add array of values
- `difference` — A minus B with absolute difference and percentage gap
- `ratio` — what percentage is "part" of "whole"?
- `apply_rate` — apply percentage (VAT, retention, markup)
- `unit_rate` — DB lookup: cost ÷ quantity

**Example questions:**
- "What is the difference?" → `operation: "difference"`
- "What percentage is MEP?" → `operation: "ratio"`
- "VAT-inclusive total" → `operation: "apply_rate"`
- "Rate per m³" → `operation: "unit_rate"`

---

## Tool Routing Logic

The system prompt routes questions to tools:

| Question Pattern | Tool Chosen |
|---|---|
| "What files do you have?" | `get_document_info` (mode: list) |
| "What sections are in this BOQ?" | `get_document_info` (mode: sections) |
| "Summarize this" | `get_document_info` (mode: summarize) |
| "Total cost / budget / outstanding?" | `aggregate_values` |
| "Budget vs actual?" | `aggregate_values` (both types) + `compute_result` (difference) |
| "Over budget categories?" | `aggregate_values` (budget + actual) + `compute_result` |
| "Compare costs?" | `aggregate_values` (groupBy: document) |
| "Difference between X and Y?" | `aggregate_values` + `compute_result` (difference) |
| "What percentage is MEP?" | `aggregate_values` (category: MEP) + `compute_result` (ratio) |
| "Key dates / milestones?" | `query_values` (type: date) |
| "Who is the contractor?" | `query_values` (type: party) |
| "VAT / retention rate?" | `query_values` (type: percentage) |
| "List expensive items?" | `query_values` (type: cost, orderBy: value_desc) |
| "Outstanding owed to vendors?" | `aggregate_values` (type: outstanding) |
| "General content search" | `search_documents` |

---

## Semantic Category Matching

Tools that accept a `category` parameter resolve it **semantically**:

1. Embed the term using `text-embedding-3-small`
2. Find nearest sheet/section names via cosine distance (< 0.65 threshold)
3. Build `ILIKE ANY(patterns)` SQL filter

*Example:*
- **User input:** `"electrical"`
- **Patterns:** `['%electrical%', '%Electrical Works%', '%ELC%']`
- **SQL:** `WHERE section_title ILIKE ANY($patterns)`

This handles abbreviations, typos, and synonyms.

---

## Type Aliases for Aggregation

The `aggregate_values` tool expands types to match variants:

| Query Type | Matches |
|---|---|
| `budget` | `budget`, `budgeted_cost`, `contract_value` |
| `actual` | `actual`, `actual_cost` |
| `committed` | `committed`, `committed_cost` |
| `variance` | `variance`, `variance_cost` |
| `outstanding` | `outstanding` |

This ensures queries work regardless of which extraction path produced the data.

---

## Answer Rendering

The agent returns **structured JSON**, never markdown:

```json
{
  "title": "Vendor Outstanding Balance",
  "summary": "Total outstanding is SAR 55,597,500.",
  "sections": [
    {
      "type": "key_facts",
      "title": "Summary",
      "items": [
        { "label": "Total outstanding", "value": "55,597,500 SAR" },
        { "label": "Vendors with balance", "value": "14 of 15" }
      ]
    },
    {
      "type": "table",
      "title": "By Vendor",
      "headers": ["Vendor", "Outstanding"],
      "rows": [["Glass Tech LLC", "18,500,000"]]
    }
  ]
}
```

The frontend (`StructuredAnswer.tsx`) renders each section type:

| Section Type | Renders As |
|---|---|
| `paragraph` | Plain text |
| `key_facts` | Label/value grid |
| `table` | Striped table |
| `timeline` | Vertical timeline |
| `list` | Bulleted list |
| `parties` | Role + company cards |

---

## Why This Design Works

| Principle | Benefit |
|---|---|
| **5 flexible tools** | Simpler agent loop, easier to maintain than 16 specialized tools |
| **Document profiles** | AI-generated query hints and tool suggestions per document |
| **Two-pass ingestion** | Chunks for search + extracted values for direct SQL |
| **Deterministic Excel extraction** | Regex-based classification, zero tokens per row |
| **Agent uses tools, not arithmetic** | 100% factual, no hallucinated numbers |
| **Async queues for everything** | No socket timeouts, consistent UX |
| **Semantic category matching** | Handles abbreviations, synonyms, typos |
| **Type normalization** | Consistent queries despite LLM variance |
| **Cascade deletes** | One SQL statement cleans up everything |
| **Structured JSON answers** | Predictable AI output, extensible UI |

---

## Tech Stack Summary

| Component | Technology |
|---|---|
| **Backend Runtime** | Node.js 18, Express, TypeScript |
| **Frontend** | Next.js 14 (App Router), React 18, Tailwind CSS |
| **AI Models** | OpenAI `gpt-5.4-mini` (extraction, profiling), `gpt-4o-mini` (agent), `text-embedding-3-small` |
| **Database** | PostgreSQL 14+ with `pgvector` (HNSW index), Drizzle ORM |
| **Job Queue** | BullMQ + Redis |
| **Parsing** | `pdf-parse`, `exceljs` |

---

## In One Sentence

**DocAgent transforms raw construction documents into an intelligent query system that answers business questions with cited, structured responses — powered by AI, grounded in SQL, with document profiles that guide query strategy.**
