# How DocAgent Works

Full technical walkthrough — from uploading a file to getting a structured answer in the UI.

Two main flows: **Ingestion** (loading documents) and **Query** (asking a question).

---

## Flow 1 — Document Ingestion

Every uploaded file goes through a 6-step pipeline before it can be queried.

```
Upload / Folder path
        │
        ▼
  1. Parse   — text extraction per page (PDF) or per row batch (Excel)
        │
        ▼
  2. Chunk   — ~6 000-char segments with 200-char overlap + page/sheet tags
        │
        ▼
  3. Embed   — text-embedding-3-small → 1 536-dim vectors stored in pgvector
        │
        ▼
  4. Classify — gpt-4o-mini reads opening content → type, project, currency, parties
        │
        ▼
  5. Extract  — deterministic Excel column classifier + per-page gpt-4o-mini for PDFs
        │           → structured rows stored in extracted_values table
        ▼
  6. Store   — document + chunks + extracted_values written to PostgreSQL
```

File uploads via the UI are queued as **BullMQ jobs** (Redis-backed). The server responds immediately with job IDs; the frontend polls every 2 seconds until all jobs reach a terminal state. The worker processes one file at a time to stay within OpenAI rate limits.

Folder-path ingestion (`POST /api/ingest`) runs synchronously and returns only when all files are processed.

---

### Step 1 — Parse

**PDF files** (`parsers/pdfParser.ts`):
- Reads the buffer once via `pdf-parse` with a `pagerender` callback
- Each page's text tokens are joined into a single string
- Result: `string[]` — one entry per page, up to 50 pages (configurable via `config.maxPdfPages`)
- Pages beyond the limit generate a warning; the rest continue

**Excel / CSV files** (`parsers/excelParser.ts`):
- `exceljs` opens the workbook and iterates every worksheet
- The first row is treated as column headers
- Data rows are formatted as `Row 5: Description: Foundation Works | Unit: m³ | Rate: 850.00`
- Rows are collected in batches of 50 before chunking

---

### Step 2 — Chunk

(`utils/chunker.ts`)

Each page or row-batch is split into chunks of ~6 000 characters. When a split is needed, the chunker prefers a paragraph break (`\n\n`), then a sentence boundary (`. `), then a hard character cut — so chunks always end near a natural boundary.

Every chunk carries metadata:
- `pageNumber` for PDF chunks
- `sheetName` + `rowRange` for Excel chunks
- A global `chunkIndex` across the whole document

The **200-character overlap** between consecutive chunks ensures a sentence straddling a boundary appears in both — no information is silently dropped.

---

### Step 3 — Embed

(`services/embeddings.ts`)

All chunk texts are sent to OpenAI's `text-embedding-3-small` model in batches of 100. Each text becomes a 1 536-dimensional float vector. Vectors are stored in the `chunks.embedding` column using PostgreSQL's `pgvector` extension (`vector(1536)` type). An HNSW index supports fast cosine-similarity queries.

---

### Step 4 — Classify

(`services/metadata.ts`)

The first two chunks (the document's opening content) are sent to `gpt-4o-mini` asking it to return JSON with:

- `type`: `contract` | `boq` | `specification` | `schedule` | `report` | `other`
- `projectName`
- `currency` (dominant currency code, e.g. `SAR`)
- `parties` (up to 4 company/organisation names)
- `summary` (one sentence)

This metadata is stored on the `documents` row and surfaced by `list_documents` to help the agent choose the right file.

---

### Step 5 — Structured Extraction

Two paths depending on file type.

**Excel** (`extractors/excelExtractor.ts`) — fully deterministic, no LLM tokens used:

1. **Header row detection** — scans the first 10 rows and picks the first with ≥2 distinct non-empty values (skips merged title rows).
2. **Column classification** — two-pass: first finds the description/label column and the item-number column; second classifies all remaining columns by type (cost, date, quantity, party, percentage, reference, duration) using regex patterns.
3. **Cost column priority** — selects a single cost column per sheet: Committed > Total Amount > plain Amount > Qty × Rate fallback. Sheets without an item-number column (summary/aggregate sheets) are excluded from line-item extraction.
4. **Row walking** — skips rows matching `TOTAL_ROW_RE` (Grand Total, Subtotal, VAT); formats each line item as `${itemNo}: ${description}` and stores in `extracted_values`.

**PDF** (`extractors/pdfExtractor.ts`) — LLM-assisted:

- Each page is sent to `gpt-4o-mini` with a structured extraction prompt
- The model returns a JSON array of `{ type, label, rawValue, numericValue, dateValue, unit, context }` objects
- Up to 5 pages are processed concurrently; invalid or malformed responses are silently dropped
- Results stored in `extracted_values` with `pageNumber`

Both paths write rows with a `type` discriminator column: `cost`, `date`, `percentage`, `duration`, `quantity`, `party`, `reference`.

---

### Step 6 — Store

(`services/documentStore.ts`, `db/schema.ts`)

The processed document, its chunks, and all extracted values are written to PostgreSQL using Drizzle ORM. Chunks are inserted in batches of 100 to stay within parameter limits. Cascading foreign keys mean deleting a document removes its chunks and extracted values automatically.

---

## Flow 2 — Answering a Question

Questions use the same **BullMQ async pattern** as file uploads — the HTTP connection closes immediately and the frontend polls until done.

```
POST /api/ask  (returns in ~5 ms)
      │  { question, history, conversationId }
      ▼
Save user message to PostgreSQL
Enqueue BullMQ job  →  202 { jobId }   ← browser receives this instantly
      │
      ▼ (background worker — concurrency 3)
Build message array
[system prompt + conversation history + user question]
      │
      ▼
┌──────────────────────────────────────────────────┐
│                  AGENT LOOP                       │  max 5 iterations
│                                                   │
│  1. openai.chat.completions.create()              │
│         model: gpt-4o-mini                        │
│         tools: 11 tool definitions                │
│                                                   │
│  GPT decides:                                     │
│   ├── finish_reason = "stop" → final answer       │
│   └── tool_calls → execute tools in parallel      │
│         │                                         │
│         ▼                                         │
│  For each tool call:                              │
│    - parse arguments from JSON                    │
│    - execute matching tool (queries PostgreSQL)   │
│    - collect SourceReference objects              │
│    - append role:"tool" message with result       │
│    - updateRequestStatus(requestId, "Calling …")  │
│         │                                         │
│         └── loop back to step 1                   │
└──────────────────────────────────────────────────┘
      │
      ▼
Parse structured JSON answer
Save assistant message to PostgreSQL
Store result in Redis job (kept 2 h)
      │
      ▼ (frontend polls GET /api/ask/jobs/:jobId every 1 s)
      { state: "completed", result: { answer, sources, toolsUsed } }
```

While the job is `active`, `GET /api/ask/jobs/:jobId` returns `{ state: "active", status: "Calling calculate cost summary…" }`. The `status` string comes from the in-process `requestStatus` map updated by the worker, and is forwarded to the loading indicator.

Multiple tool calls in the same iteration execute with `Promise.all` — the model can call `list_documents` and `calculate_cost_summary` simultaneously rather than sequentially.

---

### The System Prompt

(`services/openai.ts`)

Defines the agent's role and hard constraints:

1. **Role** — Senior Project Controller & Document Analyst
2. **Tool protocol** — call `list_documents` once at the start (first turn only), then use targeted tools with the document ID. Skip `list_documents` if document IDs are already in conversation history.
3. **Tool routing** — explicit rules for which tool to use per question type (e.g. `calculate_cost_summary` with a `category` keyword for trade-specific totals; `get_document_sections` to discover BOQ structure before filtering)
4. **Truth constraint** — every factual claim must come from tool output; "Data point not found in provided documents" is the required response when a value isn't present
5. **Output format** — final response must be a raw JSON object matching the structured answer schema; no markdown, no code fences, no prose outside the JSON

---

### The 11 Tools

All tools query the PostgreSQL `extracted_values` or `chunks` tables directly — no additional LLM calls at query time.

| Tool | Implementation |
|---|---|
| `list_documents` | Queries `documents` + `chunks` for distinct sheet names per document; returns file metadata + sheet list |
| `get_document_sections` | Groups `extracted_values` by `sheet_name`; extracts item-code letter prefixes (A-001 → A); returns sheet names with cost totals and code prefix breakdown |
| `search_documents` | pgvector cosine similarity if embeddings exist, PostgreSQL FTS otherwise; includes next chunk for context continuity |
| `extract_cost_items` | `SELECT … WHERE type='cost'`, filterable by `documentId`, `minAmount`, `maxAmount`, `category` (ILIKE on sheet name or label) |
| `calculate_cost_summary` | `GROUP BY sheet_name` with optional `category` filter that matches sheet name or item label |
| `compare_costs` | Per-document totals + item breakdown; optional `category` and `documentIds` filters |
| `extract_dates_deliverables` | `WHERE type='date' ORDER BY date_value ASC` — chronological |
| `extract_quantities` | `WHERE type='quantity'` with optional `unit` (ILIKE) and `minValue` filters |
| `extract_parties` | `WHERE type='party'` with optional `role` filter; deduplicates by (role, name) |
| `extract_percentages` | `WHERE type='percentage' ORDER BY numeric_value DESC` |
| `summarize_document` | Samples 6 chunks — 2 from start, 2 from middle, 2 from end — to show full document structure |

---

## Structured Answer Format

The final GPT response is always a JSON object — enforced by the system prompt. The backend parses it with `JSON.parse`; if parsing fails the raw text is wrapped in a `paragraph` section so the frontend never breaks.

```json
{
  "title": "Short answer title",
  "summary": "Optional one-sentence TL;DR",
  "sections": [
    { "type": "paragraph",  "content": "Plain prose." },
    { "type": "key_facts",  "title": "…", "items": [{ "label": "…", "value": "…", "citation": "File | Location" }] },
    { "type": "timeline",   "title": "…", "items": [{ "date": "…", "label": "…", "citation": "…" }] },
    { "type": "table",      "title": "…", "headers": ["…"], "rows": [["…"]] },
    { "type": "list",       "title": "…", "items": [{ "text": "…", "citation": "…" }] },
    { "type": "parties",    "title": "…", "items": [{ "role": "…", "name": "…", "citation": "…" }] }
  ]
}
```

The agent selects which section types to use based on the question — cost questions get a `table`, milestone questions get a `timeline`, scope questions get `paragraph` + `list`.

---

## Frontend Rendering

(`components/StructuredAnswer.tsx`)

Loops over `sections`; each type dispatches to a dedicated renderer:

| Section type | Rendered as |
|---|---|
| `paragraph` | Plain prose `<p>` |
| `key_facts` | Label + bold value grid, one row per item |
| `timeline` | Vertical line with blue dot and date label per milestone |
| `table` | Striped `<table>` built from `headers` and `rows` arrays |
| `list` | Bullet list with blue dots |
| `parties` | Role badge + company name card |

Every item with a `citation` field shows a small `[FileName | Location]` tag inline. Below each assistant message the collapsible **Sources** section shows the raw `SourceReference` objects collected from all tool calls during the answer.

---

## Conversation Persistence

Chat history is stored in PostgreSQL. On load, `ChatInterface` reads the conversation ID from `localStorage`, fetches the full message history, and restores the UI. User and assistant messages are written to the `messages` table after each exchange. The `answer` and `sources` columns are JSONB so the full structured answer is preserved.

---

## Data Flow Summary

```
Browser                      Server                         OpenAI
  │                             │                               │
  │── POST /api/upload ─────────▶│                               │
  │   (multipart files)          │── embed chunks (batched) ────▶│
  │                             │◀─ 1536-dim vectors ───────────│
  │                             │── classify document ──────────▶│
  │                             │◀─ metadata JSON ───────────────│
  │                             │── PDF: extract per page ──────▶│
  │                             │◀─ extracted_values JSON ───────│
  │                             │   [write to PostgreSQL]        │
  │◀── { jobs: [...] } ─────────│                               │
  │   (poll /jobs/:id)           │                               │
  │                             │                               │
  │── POST /api/ask ────────────▶│                               │
  │◀── 202 { jobId } ───────────│  (returns in ~5 ms)           │
  │   (poll /ask/jobs/:id)       │                               │
  │                             │── [worker] chat + tools ──────▶│
  │                             │◀─ tool_calls ──────────────────│
  │                             │   [query PostgreSQL]           │
  │                             │── tool results ───────────────▶│
  │                             │◀─ tool_calls or stop ──────────│
  │                             │   [repeat up to 5 iterations]  │
  │                             │── parse JSON, store in Redis   │
  │◀── { state:"completed",     │                               │
  │     result:{answer,sources}}│                               │
  │                             │                               │
  │   render StructuredAnswer    │                               │
```
