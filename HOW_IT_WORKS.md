# How DocAgent Works

Two flows drive the system: **Ingestion** (loading a document) and **Query** (asking a question). Both are async — HTTP connections close immediately and the frontend polls for results.

---

## Flow 1 — Document Ingestion

When a file is uploaded through the UI or API, it is added to a **BullMQ job queue** (Redis-backed). The server returns job IDs immediately; a background worker processes one file at a time to stay within OpenAI rate limits. Every file goes through the same six-step pipeline regardless of whether it arrived via drag-and-drop or the folder-ingest API.

```
Upload (UI) or folder path (API)
            │
            ▼
    1. Parse        extract text — page by page (PDF) or row batch (Excel)
            │
            ▼
    2. Chunk        split into ~6,000-char segments with 200-char overlap
            │
            ▼
    3. Embed        text-embedding-3-small → 1,536-dim vectors → pgvector
            │
            ▼
    4. Classify     gpt-4o-mini reads opening content → type, project, parties
            │
            ▼
    5. Extract      structured values into extracted_values table
            │         (deterministic regex for Excel; gpt-4o-mini per page for PDFs)
            ▼
    6. Store        document + chunks + extracted_values → PostgreSQL
```

### Processing Characteristics

| Characteristic | Value |
|---|---|
| Worker concurrency | 1 (to respect OpenAI rate limits) |
| Max PDF pages | 50 (configurable in `parsers/pdfParser.ts`) |
| Excel section detection | Auto-groups by section headers; flushes on header row change |
| Embedding batch size | 100 texts per API call |
| PDF extraction concurrency | 5 pages in parallel |
| Target chunk size (text) | ~800 tokens (~3,200 chars) |
| Target chunk size (tables) | ~500 tokens (~2,000 chars) |
| Overlap | 75 tokens (~300 chars) — last paragraph (text) or last 2 rows (tables) |
| Min chunk size | 40 tokens (smaller chunks merged into previous) |

---

### Step 1 — Parse

**PDF** (`parsers/pdfParser.ts`)

Uses `pdf-parse` with a **coordinate-based line reconstruction** algorithm:

1. **Line reconstruction** — Groups raw PDF text items into visual lines using Y-coordinate proximity (items within 3 units of Y are same line; ordered left→right by X). This preserves table cell alignment that simple `join(' ')` destroys.

2. **Block detection** — Classifies paragraphs into typed blocks:
   - **Headings** — Short lines (<120 chars, ≤3 visual lines) with large font (>115% of page average) OR matching heading regex (`Article`, `Section`, `Clause`, `Schedule`, numbered headings)
   - **Tables** — Paragraphs with more number tokens than word tokens
   - **Text** — Everything else

3. **Section tracking** — Headings set `currentSection` that propagates forward until a new heading resets it

```typescript
// Returns: { text: string, pageNumber: number, sectionTitle?: string }[]
const pages = await parsePdf(buffer, documentId);
```

- Pages beyond the limit (default: 50) are skipped with a warning
- Section titles preserved for downstream chunk filtering

**Excel / CSV** (`parsers/excelParser.ts`)

Uses `exceljs` with **section-aware chunking**:

1. First row treated as column headers
2. **Section detection** — A row with <2 numeric cells and ≤3 total cells is treated as a section header (e.g., "Division 3 — Concrete")
3. When a section header is found:
   - Flushes accumulated rows from previous section
   - Emits a dedicated heading chunk for searchability
   - Starts accumulating rows under new section
4. Data rows serialized as: `Row 5: Description: Foundation Works | Unit: m³ | Rate: 850.00`
5. **Token-bounded chunking** — Batches rows until `targetTokensTable` is exceeded, then flushes with 2-row carry-over overlap

Sheet names and section titles preserved for downstream filtering.

---

### Step 2 — Chunk

(`utils/chunker.ts`)

**Token-based chunking** — Chunks are sized by token count, not characters (1 token ≈ 4 characters):

| Chunk type | Target size | Overlap |
|---|---|---|
| Text/clauses | ~800 tokens (~3,200 chars) | Last paragraph (or last sentence if no paragraph break) |
| Tables | ~500 tokens (~2,000 chars) | Last 2 data rows |
| Headings | Flow into following text block | N/A |

**PDF** — Section-aware token-bounded chunking:

All blocks from all pages are flattened into a single stream before chunking. This allows:
- Headings to propagate across page breaks naturally
- Section context to be preserved even when chunks span multiple pages
- Better semantic coherence — chunks stay within topical boundaries

**Chunking rules:**
1. Blocks are grouped until the token budget for their type is reached
2. Type change (text → table or vice-versa) forces a flush — chunks stay homogeneous
3. Single blocks that are too large are split at paragraph/sentence boundaries first
4. Chunks smaller than 40 tokens are merged into the previous chunk (avoids noise)
5. Smart overlap is appended as a prefix to the next chunk

Each chunk preserves: `pageNumber`, `sectionTitle`, `chunkIndex`, `chunkType` ('heading' | 'table' | 'text')

**Excel** — Token-bounded section chunking:

Chunks are built per-section with smart batching:
1. Accumulate rows within a section until `targetTokensTable` (~500 tokens) is exceeded
2. When limit hit: flush chunk, carry over last 2 rows into next batch (overlap)
3. Section headers emit dedicated heading chunks: `[Sheet: Electrical] Section: Cable Tray Systems`

Each chunk preserves: `sheetName`, `rowRange`, `sectionTitle`, `chunkIndex`, `chunkType` ('heading' | 'table')

The overlap strategy ensures no data is lost at section boundaries — the last 2 rows of each batch appear in both adjacent chunks, giving the next chunk column context for semantic search.

---

### Step 3 — Embed

(`services/embeddings.ts`)

All chunk texts are sent to `text-embedding-3-small` in batches of 100. Each text returns as a **1,536-dimensional float vector**, stored in `chunks.embedding` (`vector(1536)`).

**Index:** An HNSW index on the `embedding` column enables fast cosine-similarity queries at search time:

```sql
CREATE INDEX chunks_embedding_idx ON chunks
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

**Similarity threshold:** Semantic search returns chunks with cosine distance < 0.75 by default.

---

### Step 4 — Classify

(`services/metadata.ts`)

The first two chunks of the document are sent to `gpt-4o-mini` with a structured prompt asking for:

| Field | Type | Description |
|---|---|---|
| `type` | `contract` \| `boq` \| `specification` \| `schedule` \| `report` \| `other` | Document category |
| `projectName` | `string` | Project name extracted from header/intro |
| `currency` | `string` | Dominant currency code (e.g., `SAR`, `USD`) |
| `parties` | `string[]` | Up to 4 organization names mentioned |
| `summary` | `string` | One-sentence document summary |

This metadata is stored on the `documents` row and returned by `list_documents` so the agent can pick the right file without reading every document.

---

### Step 5 — Structured Extraction

A second pass pulls individual typed values into the `extracted_values` table for direct SQL queries. Both PDF and Excel now use **LLM-driven schema inference** with `gpt-5.4-mini`.

#### Excel — LLM-Driven Schema Inference (`extractors/excelExtractor.ts`)

**Column classification via LLM** — replaces deterministic regex with semantic understanding:

1. **Header detection** — scans first 10 rows, picks first row with ≥2 distinct non-empty values (skips merged title rows)

2. **Sample collection** — grabs up to 5 data rows aligned with header columns

3. **Schema inference** — sends headers + samples to `gpt-5.4-mini` with prompt:
   ```
   Classify every column as:
     - "label"   → primary description / name of each row item
     - "item_no" → sequential item number, code, or reference prefix
     - "value"   → column worth extracting (with type: cost, date, percentage, quantity, party, reference, duration, unit_rate, or open-ended like risk_level, status)
     - "skip"    → row counters, blank columns, footnotes
   ```

4. **Role mapping** — LLM response mapped to actual Excel column numbers

5. **Row walking** — for each data row:
   - Skips rows matching `TOTAL_ROW_RE` (Grand Total, Subtotal, VAT)
   - Extracts values from all columns marked as `value`
   - Computes cost fallback: `qty × unit_rate` when no direct cost column exists
   - Stores with `rowLabel = "A-001: Foundation Works"` format

6. **Sheet filtering** — sheets with no `label` column (summary/aggregate sheets) are skipped entirely

**Supported types:**
- Standard: `cost`, `date`, `percentage`, `quantity`, `party`, `reference`, `duration`, `unit_rate`
- Open-ended: `risk_level`, `status`, `completion_rate`, `technical_score`, `weighted_score`, `penalty_rate`, etc.

**Currency detection:** Infers from column unit or header pattern (SAR, AED, USD, etc.); defaults to SAR.

#### PDF — LLM-Assisted Extraction (`extractors/pdfExtractor.ts`)

Each page is sent to `gpt-5.4-mini` with a structured extraction prompt. The model returns a JSON array of:

```typescript
interface ExtractedValue {
  type: string;        // snake_case: standard or LLM-invented
  label: string;
  rawValue: string;
  numericValue?: number;
  dateValue?: Date;
  unit?: string;
  context: string;     // full sentence or clause (max 200 chars)
  pageNumber: number;
}
```

**Concurrency:** Up to 5 pages processed in parallel to balance speed vs. rate limits.

**Validation:**
- Type must match snake_case pattern (`/^[a-z][a-z0-9_]*$/`)
- Label and rawValue required
- Malformed responses dropped silently

Results stored with `pageNumber` for traceability.

---

### Step 6 — Store

(`db/schema.ts`, Drizzle ORM)

The document row, chunks (inserted in batches of 100), and extracted values are written to PostgreSQL.

**Cascade deletes:** `chunks` and `extracted_values` both carry `ON DELETE CASCADE` — deleting a document cleans up everything with a single SQL statement.

**Schema overview:**

```
documents
├── id (uuid)
├── file_name (text)
├── file_path (text)
├── file_size (bigint)
├── mime_type (text)
├── type (text)           -- contract, boq, specification, etc.
├── project_name (text)
├── currency (text)
├── parties (text[])
├── summary (text)
└── created_at (timestamp)

chunks
├── id (uuid)
├── document_id (uuid) → documents.id
├── content (text)
├── embedding (vector(1536))
├── page_number (int)
├── sheet_name (text)
├── row_range (text)
└── chunk_index (int)

extracted_values
├── id (uuid)
├── document_id (uuid) → documents.id
├── type (text)
├── label (text)
├── raw_value (text)
├── numeric_value (double precision)
├── date_value (timestamp)
├── unit (text)
├── context (text)
├── page_number (int)
└── sheet_name (text)
```

---

## Flow 2 — Answering a Question

`POST /api/ask` enqueues a BullMQ job and returns `202 { jobId }` in ~5 ms. The agent loop runs in a background worker. The frontend polls `GET /api/ask/jobs/:jobId` every second until the job completes.

```
POST /api/ask  →  save user message  →  enqueue job  →  202 { jobId }
                                                               │
                              ┌────────────────────────────────┘
                              │  background worker (concurrency 3)
                              ▼
             Build: [system prompt] + [user question]
                              │
                              ▼
            ┌─────────────────────────────────────────┐
            │              AGENT LOOP                  │  max 5 iterations
            │                                         │
            │  gpt-4o-mini receives message array      │
            │  + 15 tool definitions                   │
            │                                         │
            │  finish_reason = "stop"  →  write answer │
            │  finish_reason = "tool_calls"            │
            │    → execute all tool calls in parallel  │
            │    → each tool queries PostgreSQL        │
            │    → append tool results to messages     │
            │    → update requestStatus ("Calling …")  │
            │    → loop                                │
            └─────────────────────────────────────────┘
                              │
                              ▼
              Parse JSON answer  →  save assistant message
              Store result in Redis (kept 2 h)
                              │
                              ▼ (frontend polls /ask/jobs/:jobId)
              { state: "completed", result: { answer, sources, toolsUsed } }
```

### Job States

| State | Description | Poll Response |
|---|---|---|
| `waiting` | In queue, not yet picked up | `{ state: "active", status: "Waiting..." }` |
| `active` | Worker processing | `{ state: "active", status: "Calling <tool>..." }` |
| `completed` | Answer ready | `{ state: "completed", result: {...} }` |
| `failed` | Error occurred | `{ state: "failed", error: "..." }` |

### Live Status Updates

While the job is active, the poll endpoint returns `{ state: "active", status: "Calling calculate cost summary…" }`. That `status` string comes from an in-process `requestStatus` map updated by the worker on each tool call — the same Node.js process, no IPC needed. The loading indicator in the UI displays this text live.

---

### The System Prompt

(`services/openai.ts`)

The system prompt defines the agent's role and enforces hard constraints:

**Role:** Senior Project Controller & Document Analyst

**Model:** `gpt-5.4-mini` for extraction tasks, `gpt-4o-mini` for classification and summarization

**Tool protocol:**
- Call `list_documents` once (first turn only)
- Skip `list_documents` if document IDs are already in the message history
- For compound questions ("compare costs AND list parties"), make all independent tool calls in the same turn — do not wait for one to finish before starting the next

**Tool routing rules:**
- `calculate_cost_summary` → trade totals, budget breakdowns (results pre-sorted DESC — first group = highest)
- `get_document_sections` → discover BOQ structure, sheet lists (call before filtering by category if unsure which keyword to use)
- `extract_cost_items` → line-item detail, filtering by amount/category (results pre-sorted DESC — first item = most expensive)
- `compare_costs` → side-by-side comparison (results pre-sorted DESC — first document = highest total)
- `search_documents` → open-ended prose questions (clauses, specs, narrative)
- `calculate_cost_variance` → "how much more expensive" questions
- `calculate_percentage_of_total` → "what share/percentage" questions
- `apply_percentage` → "VAT-inclusive total", "apply retention", "add markup" questions
- `compute_difference` → when you already have two numbers and need the difference
- `calculate_unit_rate` → "rate per m³/m²" questions (never divide yourself)
- All other tools → explicit question type matches

**Summary sheet subtotals handling:**
When the response includes `summarySheetSubtotals`:
- These are pre-aggregated cross-sheet subtotals from a summary/rollup sheet
- Each entry represents a different scope (e.g., "BOQ", "Civil", "Phase 1")
- The top-level `grandTotal` reflects only regular line-item sheets
- Match the user's stated scope to the correct label in `summarySheetSubtotals`
- **Never** sum all subtotals together or report `grandTotal` when only `summarySheetSubtotals` are present

**Truth constraint:**
- Every number, date, or party name **must** come from tool output
- Required response when a value is not found: `"Data point not found in provided documents"`
- **NEVER** perform arithmetic (subtraction, division, percentage) in your head or in the final answer
- If a difference, ratio, or percentage is needed, call the appropriate calculation tool and report its output exactly
- LLM arithmetic is unreliable and will produce wrong answers

**Fallback strategy:**
If structured extraction returns no results — `extract_cost_items`, `calculate_cost_summary`, or `extract_quantities` returns empty:
- Do **NOT** retry with different filters or parameters
- The document may use non-standard structure, non-English headers, or contain data types outside the standard construction schema
- Fall back immediately to `search_documents` to discover what the document contains
- Then `summarize_document` for a broad overview
- Answer from those results

**Output format:**
- Final response must be a raw JSON object
- No markdown, no code fences, no prose outside the JSON

---

### The 15 Tools

All tools query PostgreSQL directly — **no LLM calls at query time**.

| Tool | SQL Strategy | What It Queries |
|---|---|---|
| `list_documents` | `SELECT` on `documents` + `SELECT DISTINCT sheet_name` from `chunks` | File metadata and sheet list |
| `get_document_sections` | `GROUP BY sheet_name` on `extracted_values`; extract item-code letter prefixes (A-001 → A) | Sheet names with cost totals and code breakdown |
| `search_documents` | pgvector cosine similarity (fallback: PostgreSQL FTS with `to_tsvector`) | Semantic search; includes adjacent chunk for context |
| `extract_cost_items` | `WHERE type = 'cost'`; filterable by `documentId`, `minAmount`, `maxAmount`, `category` (ILIKE on sheet name or label) | Cost line items with optional filters |
| `calculate_cost_summary` | `SUM(numeric_value) GROUP BY sheet_name`; `category` filter matches both `sheet_name` and `ev.label` | Trade/subtotal breakdowns |
| `compare_costs` | Per-document `SUM()` with `JOIN` on `documents`; filterable by `category` and/or `documentIds` | Side-by-side cost comparison |
| `calculate_cost_variance` | Subtraction of two `calculate_cost_summary` results | Percentage and absolute difference |
| `calculate_percentage_of_total` | `(part / total) * 100` using two tool results | Share of budget analysis |
| `apply_percentage` | `base + (base * rate / 100)` or `base - (base * rate / 100)` | VAT-inclusive totals, retention deductions, markup applications |
| `calculate_unit_rate` | `SUM(cost) / SUM(quantity)` from two extractions | Rate per unit (m³, m², etc.) |
| `compute_difference` | Simple arithmetic on two numeric tool results | Absolute difference |
| `extract_dates_deliverables` | `WHERE type = 'date' ORDER BY date_value ASC` | Chronological milestone list |
| `extract_quantities` | `WHERE type = 'quantity'`; filterable by `unit` (ILIKE) and `minValue` | Quantity takeoffs |
| `extract_parties` | `WHERE type = 'party'`; filterable by `role`; `DISTINCT ON (role, name)` | Contractors, subcontractors, consultants |
| `extract_percentages` | `WHERE type = 'percentage' ORDER BY numeric_value DESC` | Tax rates, retention, penalties |
| `summarize_document` | Samples 6 chunks — 2 from start, 2 from middle, 2 from end; sends to `gpt-4o-mini` | Document summary |

---

### Tool Call Flow

```
Agent receives: "What is the total MEP cost?"
        │
        ▼
Iteration 1:
  gpt-4o-mini decides: call calculate_cost_summary(category="MEP")
        │
        ▼
  Tool executes SQL:
  SELECT sheet_name, SUM(numeric_value) as total
  FROM extracted_values
  WHERE type = 'cost'
    AND (sheet_name ILIKE '%MEP%' OR label ILIKE '%MEP%')
  GROUP BY sheet_name
        │
        ▼
  Tool result appended to messages:
  [{ sheet_name: "Electrical Works", total: 12500000 },
   { sheet_name: "Mechanical Works", total: 8300000 }]
        │
        ▼
Iteration 2:
  gpt-4o-mini has data → formats JSON answer
  finish_reason = "stop"
        │
        ▼
  Answer saved, job completed
```

---

## Answer Format

Every final response is a JSON object. The backend parses it with `JSON.parse`; if parsing fails the raw text is wrapped in a `paragraph` section so the frontend never breaks.

```json
{
  "title": "Short answer title",
  "summary": "One-sentence TL;DR (optional)",
  "sections": [
    { "type": "paragraph", "content": "Plain prose." },
    {
      "type": "key_facts",
      "title": "Project Details",
      "items": [
        { "label": "Contract Value", "value": "SAR 48,500,000", "citation": "Contract.pdf | Page 1" }
      ]
    },
    {
      "type": "timeline",
      "title": "Key Milestones",
      "items": [
        { "date": "1 Apr 2024", "label": "Commencement", "citation": "Contract.pdf | Page 7" }
      ]
    },
    {
      "type": "table",
      "title": "Cost Breakdown",
      "headers": ["Item", "Description", "Amount (SAR)"],
      "rows": [["A-001", "Pile Foundation", "12,500,000"]]
    },
    {
      "type": "list",
      "title": "Scope Items",
      "items": [
        { "text": "Foundation and substructure works", "citation": "Spec.pdf | Page 3" }
      ]
    },
    {
      "type": "parties",
      "title": "Contract Parties",
      "items": [
        { "role": "Employer", "name": "Al Nakheel Development Co.", "citation": "Contract.pdf | Page 1" }
      ]
    }
  ]
}
```

### Section Selection Logic

The agent chooses section types based on the question type:

| Question type | Section types produced |
|---|---|
| Cost breakdown | `table` + optional `key_facts` (totals) |
| Milestones/dates | `timeline` + optional `paragraph` (context) |
| Scope/narrative | `paragraph` + `list` |
| Parties | `parties` + optional `key_facts` |
| General summary | `paragraph` + `key_facts` |

The frontend owns all rendering decisions — the AI never decides how data is visually presented.

---

## Frontend Rendering

(`components/StructuredAnswer.tsx`)

Loops over `sections` and dispatches each to a typed renderer:

| Section type | Rendered as |
|---|---|
| `paragraph` | Plain `<p>` with Tailwind prose |
| `key_facts` | Two-column label/value grid (blue labels, bold values) |
| `timeline` | Vertical line, blue dot per milestone, date badge |
| `table` | Striped `<table>` from `headers` + `rows` |
| `list` | Bullet list with blue dots |
| `parties` | Role badge (gray) + company name card |

### Citations

Items with a `citation` field show an inline `[File | Location]` tag. Clicking expands a tooltip with full source metadata.

### Sources Collapsible

Below each answer, a collapsible **Sources** section lists the raw `SourceReference` objects collected across all tool calls during that response:

```typescript
interface SourceReference {
  documentId: string;
  documentName: string;
  pageNumber?: number;
  sheetName?: string;
  rowRange?: string;
  content: string;
}
```

---

## Conversation Persistence

On first load, `ChatInterface` creates a conversation via `POST /api/conversations` and stores the ID in `localStorage`. On subsequent loads it fetches the full message history and restores the UI.

### Message Schema

```typescript
interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;           // User question text
  answer?: object;           // Parsed JSON for assistant
  sources?: SourceReference[];
  toolsUsed?: string[];
  createdAt: Date;
}
```

- User messages are saved **before** the ask job is enqueued
- Assistant messages are saved inside the worker once the agent finishes
- The `answer` and `sources` columns are JSONB, so the full structured response survives page reload

---

## Full Data Flow

```
Browser                     Server                          OpenAI
  │                            │                               │
  │── POST /api/upload ────────▶│                               │
  │◀── { jobs: [...] } ─────────│  (queued, returns instantly)  │
  │   poll /upload/jobs/:id     │                               │
  │                            │── embed chunks (batch 100) ──▶│
  │                            │◀── 1,536-dim vectors ──────────│
  │                            │── classify document ──────────▶│
  │                            │◀── metadata JSON ──────────────│
  │                            │── PDF: extract per page ──────▶│
  │                            │◀── extracted_values JSON ───────│
  │                            │   write to PostgreSQL          │
  │◀── { state: "completed" } ──│                               │
  │                            │                               │
  │── POST /api/ask ───────────▶│                               │
  │◀── 202 { jobId } ───────────│  (queued, returns in ~5 ms)   │
  │   poll /ask/jobs/:jobId     │                               │
  │                            │── [worker] chat + tools ──────▶│
  │                            │◀── tool_calls ─────────────────│
  │                            │   query PostgreSQL             │
  │                            │── tool results ───────────────▶│
  │                            │◀── tool_calls or stop ──────────│
  │                            │   repeat up to 5 iterations    │
  │                            │   parse JSON, store in Redis   │
  │◀── { state: "completed",   │                               │
  │     result: { answer, … }} │                               │
  │   render StructuredAnswer   │                               │
```

---

## Performance Characteristics

| Operation | Typical Latency | Notes |
|---|---|---|
| Upload job enqueue | <10 ms | Returns before processing |
| PDF parse (10 pages) | ~800 ms | Coordinate-based line reconstruction + block detection |
| Excel parse (500 rows) | ~300 ms | Section-aware chunking with heading emission |
| Embedding (100 chunks) | ~2 s | Batch API call |
| Classification | ~1 s | Single `gpt-4o-mini` call |
| PDF extraction (10 pages) | ~4 s | 5 concurrent `gpt-5.4-mini` calls |
| Excel extraction (5 sheets) | ~3 s | `gpt-5.4-mini` schema inference per sheet |
| Ask job (simple) | ~2 s | 1-2 tool calls |
| Ask job (complex) | ~8 s | 4-5 tool calls, max iterations |

---

## Error Handling

| Error type | Handling strategy |
|---|---|
| PDF parse failure | Job marked failed, error message shown in UI |
| Excel parse failure | Job marked failed, specific row/column error logged |
| Embedding API error | Retry with exponential backoff (max 3 attempts) |
| Classification failure | Document stored without metadata, extraction continues |
| Extraction failure | Malformed responses dropped, valid ones stored |
| Tool SQL error | Error returned to agent, agent can retry or report "not found" |
| Answer JSON parse failure | Raw text wrapped in `paragraph` section, UI still renders |

---

## Security Considerations

| Concern | Current state | Recommendation |
|---|---|---|
| Authentication | None | Add JWT/session middleware for multi-user |
| Document isolation | None (global DB) | Add `user_id` FK to documents, filter queries |
| File upload validation | MIME type check only | Add virus scanning, size limits |
| SQL injection | Drizzle ORM parameterized queries | Continue using ORM, no raw SQL with interpolation |
| API rate limiting | None | Add express-rate-limit for public deployments |
| Secrets management | `.env` file | Use environment variables from vault/secret manager |
