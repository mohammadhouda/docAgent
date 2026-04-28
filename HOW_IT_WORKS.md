# How DocAgent Works

Two flows drive the system: **Ingestion** (loading a document) and **Query** (asking a question). Both are async — HTTP connections close immediately and the frontend polls for results.

---

## Flow 1 — Document Ingestion

When a file is uploaded through the UI, it is added to a **BullMQ job queue** (Redis-backed). The server returns job IDs immediately; a background worker processes one file at a time to stay within OpenAI rate limits. Every file goes through the same six-step pipeline regardless of whether it arrived via drag-and-drop or the folder-ingest API.

```
Upload (UI) or folder path (API)
            │
            ▼
    1. Parse        extract text — page by page (PDF) or row batch (Excel)
            │
            ▼
    2. Chunk        split into ~6 000-char segments with 200-char overlap
            │
            ▼
    3. Embed        text-embedding-3-small → 1 536-dim vectors → pgvector
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

---

### Step 1 — Parse

**PDF** (`parsers/pdfParser.ts`): uses `pdf-parse` with a `pagerender` callback to get per-page text. Returns `string[]`, one entry per page, up to 50 pages (configurable). Pages beyond the limit are skipped with a warning.

**Excel / CSV** (`parsers/excelParser.ts`): `exceljs` iterates every worksheet. The first row is treated as column headers. Data rows are serialised as `Row 5: Description: Foundation Works | Unit: m³ | Rate: 850.00` and collected in batches of 50 before chunking.

---

### Step 2 — Chunk

(`utils/chunker.ts`)

Each page or row-batch is split into segments of ~6 000 characters. When a cut is needed the chunker prefers a paragraph boundary (`\n\n`), then a sentence boundary (`. `), then a hard character cut — so segments always break at natural points.

Each chunk stores `pageNumber` (PDF) or `sheetName` + `rowRange` (Excel), plus a global `chunkIndex`. The 200-character overlap means any sentence that straddles a boundary appears in both adjacent chunks — nothing is silently dropped.

---

### Step 3 — Embed

(`services/embeddings.ts`)

All chunk texts are sent to `text-embedding-3-small` in batches of 100. Each text returns as a 1 536-dimensional float vector, stored in `chunks.embedding` (`vector(1536)`). An HNSW index on that column enables fast cosine-similarity queries at search time.

---

### Step 4 — Classify

(`services/metadata.ts`)

The first two chunks of the document are sent to `gpt-4o-mini` with a prompt asking for:

- `type` — `contract` | `boq` | `specification` | `schedule` | `report` | `other`
- `projectName`
- `currency` — dominant currency code (e.g. `SAR`)
- `parties` — up to 4 organisation names
- `summary` — one sentence

This metadata is stored on the `documents` row and returned by `list_documents` so the agent can pick the right file without reading every document.

---

### Step 5 — Structured Extraction

A second pass pulls individual typed values into the `extracted_values` table for direct SQL queries. The path differs by file type.

**Excel** (`extractors/excelExtractor.ts`) — fully deterministic, zero LLM tokens:

1. **Header detection** — scans the first 10 rows, picks the first with ≥2 distinct non-empty values (skips merged title rows).
2. **Column classification** — two-pass: first locates the description and item-number columns; second classifies all others by type (`cost`, `date`, `quantity`, `party`, `percentage`, `reference`, `duration`) using regex.
3. **Cost column priority** — Committed > Total Amount > Amount > Qty × Rate fallback. Sheets with no item-number column (summary/aggregate sheets) are skipped entirely.
4. **Row walking** — rows matching `TOTAL_ROW_RE` (Grand Total, Subtotal, VAT) are skipped; each line item is stored as `A-001: Foundation Works`.

**PDF** (`extractors/pdfExtractor.ts`) — LLM-assisted:

Each page is sent to `gpt-4o-mini` with a structured extraction prompt. The model returns a JSON array of `{ type, label, rawValue, numericValue, dateValue, unit, context }` objects. Up to 5 pages run concurrently; malformed responses are dropped silently. Results are stored with `pageNumber`.

---

### Step 6 — Store

(`db/schema.ts`, Drizzle ORM)

The document row, chunks (inserted in batches of 100), and extracted values are written to PostgreSQL. `chunks` and `extracted_values` both carry `ON DELETE CASCADE` — deleting a document cleans up everything with a single SQL statement.

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
            │  + 11 tool definitions                   │
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

While the job is active, the poll endpoint returns `{ state: "active", status: "Calling calculate cost summary…" }`. That `status` string comes from an in-process `requestStatus` map updated by the worker on each tool call — the same Node.js process, no IPC needed. The loading indicator in the UI displays this text live.

---

### The System Prompt

(`services/openai.ts`)

The system prompt defines the agent's role and enforces hard constraints:

- **Role** — Senior Project Controller & Document Analyst
- **Tool protocol** — call `list_documents` once (first turn only); skip it if document IDs are already in the message history
- **Tool routing** — explicit rules for which tool to use per question type: `calculate_cost_summary` for trade totals, `get_document_sections` to discover BOQ structure, `extract_cost_items` for line-item detail, `search_documents` only for open-ended prose questions
- **Truth constraint** — every number, date, or party name must come from tool output; the required response when a value is not found is `"Data point not found in provided documents"`
- **Output format** — the final response must be a raw JSON object; no markdown, no code fences, no prose outside the JSON

---

### The 11 Tools

All tools query PostgreSQL directly — no LLM calls at query time.

| Tool | What it queries |
|---|---|
| `list_documents` | `documents` + distinct sheet names from `chunks`; returns file metadata and sheet list |
| `get_document_sections` | Groups `extracted_values` by `sheet_name`; extracts item-code letter prefixes (A-001 → A); returns sheet names with cost totals and code breakdown |
| `search_documents` | pgvector cosine similarity when embeddings exist; PostgreSQL FTS fallback; includes adjacent chunk for context continuity |
| `extract_cost_items` | `WHERE type = 'cost'`; filterable by `documentId`, `minAmount`, `maxAmount`, `category` (ILIKE on sheet name or label) |
| `calculate_cost_summary` | `GROUP BY sheet_name`; `category` filter matches both `sheet_name` and `ev.label` — handles sheet-per-trade and single-sheet BOQs |
| `compare_costs` | Per-document totals and item breakdown; filterable by `category` and/or `documentIds` |
| `extract_dates_deliverables` | `WHERE type = 'date' ORDER BY date_value ASC` |
| `extract_quantities` | `WHERE type = 'quantity'`; filterable by `unit` (ILIKE) and `minValue` |
| `extract_parties` | `WHERE type = 'party'`; filterable by `role`; deduplicates by (role, name) |
| `extract_percentages` | `WHERE type = 'percentage' ORDER BY numeric_value DESC` |
| `summarize_document` | Samples 6 chunks — 2 from start, 2 from middle, 2 from end |

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
      "items": [{ "label": "Contract Value", "value": "SAR 48,500,000", "citation": "Contract.pdf | Page 1" }]
    },
    {
      "type": "timeline",
      "title": "Key Milestones",
      "items": [{ "date": "1 Apr 2024", "label": "Commencement", "citation": "Contract.pdf | Page 7" }]
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
      "items": [{ "text": "Foundation and substructure works", "citation": "Spec.pdf | Page 3" }]
    },
    {
      "type": "parties",
      "title": "Contract Parties",
      "items": [{ "role": "Employer", "name": "Al Nakheel Development Co.", "citation": "Contract.pdf | Page 1" }]
    }
  ]
}
```

The agent chooses section types based on the question. Cost questions produce a `table`. Milestone questions produce a `timeline`. Scope questions produce `paragraph` + `list`. The frontend owns all rendering decisions — the AI never decides how data is visually presented.

---

## Frontend Rendering

(`components/StructuredAnswer.tsx`)

Loops over `sections` and dispatches each to a typed renderer:

| Section type | Rendered as |
|---|---|
| `paragraph` | Plain `<p>` |
| `key_facts` | Two-column label/value grid |
| `timeline` | Vertical line, blue dot per milestone |
| `table` | Striped `<table>` from `headers` + `rows` |
| `list` | Bullet list with blue dots |
| `parties` | Role badge + company name card |

Items with a `citation` field show an inline `[File | Location]` tag. Below each answer a collapsible **Sources** section lists the raw `SourceReference` objects collected across all tool calls during that response.

---

## Conversation Persistence

On first load, `ChatInterface` creates a conversation via `POST /api/conversations` and stores the ID in `localStorage`. On subsequent loads it fetches the full message history and restores the UI. User messages are saved before the ask job is enqueued; assistant messages are saved inside the worker once the agent finishes. The `answer` and `sources` columns are JSONB, so the full structured response survives page reload.

---

## Full Data Flow

```
Browser                     Server                          OpenAI
  │                            │                               │
  │── POST /api/upload ────────▶│                               │
  │◀── { jobs: [...] } ─────────│  (queued, returns instantly)  │
  │   poll /upload/jobs/:id     │                               │
  │                            │── embed chunks (batch 100) ──▶│
  │                            │◀── 1 536-dim vectors ──────────│
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
